//! Live checks against the local MongoDB (a standalone `mongod`): connection and command
//! monitoring, duplicate keys from every write path, the transaction fallback, id filters and
//! JSON of a document read back. Each test uses its own `dima_test_store_<random>` database and
//! drops it. Skipped with a message when `DIMA_TEST_MONGO_URI` is not set.

use anyhow::{Context, Result};
use bson::oid::ObjectId;
use bson::{Bson, DateTime, Document, doc};
use dima_store::mongo::connection::{CommandFailed, CommandStarted, CommandSucceeded};
use dima_store::mongo::error::{duplicate_key, is_duplicate_key, is_transaction_unsupported};
use dima_store::mongo::id::{DocId, IdType, read_id};
use dima_store::mongo::transaction::with_transaction_or_fallback;
use dima_store::mongo::{CommandHook, MongoConfig, MongoError, MongoStore, json};
use futures_util::FutureExt;
use mongodb::IndexModel;
use mongodb::options::IndexOptions;
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn uri() -> Option<String> {
    let uri = std::env::var("DIMA_TEST_MONGO_URI").ok();
    if uri.is_none() {
        eprintln!("skipped: DIMA_TEST_MONGO_URI is not set (eval \"$(dima-rust/tools/test-env)\")");
    }
    uri
}

fn test_database() -> String {
    format!("dima_test_store_{}", ObjectId::new().to_hex())
}

#[derive(Default)]
struct Recorder {
    events: Mutex<Vec<String>>,
}

impl CommandHook for Recorder {
    fn started(&self, event: &CommandStarted<'_>) {
        if let Ok(mut events) = self.events.lock() {
            events.push(format!(
                "started {} {:?}",
                event.command_name, event.collection
            ));
        }
    }

    fn succeeded(&self, event: &CommandSucceeded<'_>) {
        if let Ok(mut events) = self.events.lock() {
            events.push(format!(
                "succeeded {} {:?} {}",
                event.command_name,
                event.collection,
                event.duration < Duration::from_secs(30)
            ));
        }
    }

    fn failed(&self, event: &CommandFailed<'_>) {
        if let Ok(mut events) = self.events.lock() {
            events.push(format!(
                "failed {} {:?} {:?}",
                event.command_name, event.collection, event.code
            ));
        }
    }
}

#[tokio::test]
async fn connects_and_reports_commands() -> Result<()> {
    let Some(uri) = uri() else { return Ok(()) };
    let recorder = Arc::new(Recorder::default());
    let name = test_database();
    let config = MongoConfig {
        database: Some(name.clone()),
        app_name: Some("dima-store-test".into()),
        ..MongoConfig::new(uri.clone())
    };
    let store = MongoStore::connect(&config, Some(recorder.clone())).await?;
    assert_eq!(store.database().name(), name);
    let coll = store.documents("hooked");
    coll.insert_one(doc! { "_id": 1, "text": "héllo 👋🏽 مرحبا" })
        .await?;
    let _ = coll.find_one(doc! { "_id": 1 }).await?;
    let failure = store
        .database()
        .run_command(doc! { "find": "hooked", "filter": { "$bogus": 1 } })
        .await;
    assert!(failure.is_err());
    store.database().drop().await?;
    let events = recorder
        .events
        .lock()
        .map(|e| e.clone())
        .unwrap_or_default();
    for expected in [
        "started insert Some(\"hooked\")",
        "succeeded insert Some(\"hooked\") true",
        "started find Some(\"hooked\")",
        "succeeded find Some(\"hooked\") true",
        "failed find Some(\"hooked\") Some(2)",
    ] {
        assert!(
            events.iter().any(|e| e == expected),
            "missing {expected:?} in {events:#?}"
        );
    }
    assert!(
        !events
            .iter()
            .any(|e| e.contains("hello") || e.contains("saslStart")),
        "{events:#?}"
    );
    // Without a path in the URI, the database is the Node driver's default.
    let default = MongoStore::connect(&MongoConfig::new(uri), None).await?;
    assert!(["test"].contains(&default.database().name()) || uri_has_database());
    default.shutdown().await;
    store.shutdown().await;
    Ok(())
}

fn uri_has_database() -> bool {
    std::env::var("DIMA_TEST_MONGO_URI").is_ok_and(|uri| {
        uri.split_once("://")
            .and_then(|(_, rest)| rest.split_once('/'))
            .is_some_and(|(_, path)| !path.is_empty() && !path.starts_with('?'))
    })
}

#[tokio::test]
async fn bad_configuration_never_echoes_the_uri() {
    let config = MongoConfig::new("mongodb://user:hunter2@[not a host");
    let error = MongoStore::connect(&config, None).await.err();
    let text = error.as_ref().map(ToString::to_string).unwrap_or_default();
    assert!(matches!(error, Some(MongoError::Config(_))), "{text}");
    assert!(!text.contains("hunter2"), "{text}");
    let empty = MongoStore::connect(&MongoConfig::new("  "), None).await;
    assert!(matches!(empty, Err(MongoError::Config(_))));
}

#[tokio::test]
async fn duplicate_keys_from_every_write_path() -> Result<()> {
    let Some(uri) = uri() else { return Ok(()) };
    let config = MongoConfig {
        database: Some(test_database()),
        ..MongoConfig::new(uri)
    };
    let store = MongoStore::connect(&config, None).await?;
    let coll = store.documents("events");
    let index = IndexModel::builder()
        .keys(doc! { "eventKey": 1 })
        .options(IndexOptions::builder().unique(true).build())
        .build();
    coll.create_index(index).await?;
    coll.insert_one(doc! { "_id": "a", "eventKey": "k👋" })
        .await?;

    let insert = coll
        .insert_one(doc! { "_id": "b", "eventKey": "k👋" })
        .await
        .err()
        .context("insert must fail")?;
    let found = duplicate_key(&insert).context("insert duplicate")?;
    assert_eq!(found.index.as_deref(), Some("eventKey_1"));
    assert!(found.message.starts_with("E11000"));

    let upsert = coll
        .update_one(doc! { "_id": "c" }, doc! { "$set": { "eventKey": "k👋" } })
        .upsert(true)
        .await
        .err()
        .context("upsert must fail")?;
    assert_eq!(
        duplicate_key(&upsert).and_then(|d| d.index).as_deref(),
        Some("eventKey_1")
    );

    let many = coll
        .insert_many([
            doc! { "_id": "d", "eventKey": "other" },
            doc! { "_id": "e", "eventKey": "k👋" },
        ])
        .await
        .err()
        .context("insert_many must fail")?;
    assert!(is_duplicate_key(&many));

    let modify = coll
        .find_one_and_update(doc! { "_id": "f" }, doc! { "$set": { "eventKey": "k👋" } })
        .upsert(true)
        .await
        .err()
        .context("find_one_and_update must fail")?;
    assert_eq!(
        duplicate_key(&modify).and_then(|d| d.index).as_deref(),
        Some("eventKey_1")
    );

    let primary = coll
        .insert_one(doc! { "_id": "a" })
        .await
        .err()
        .context("_id clash")?;
    assert_eq!(
        duplicate_key(&primary).and_then(|d| d.index).as_deref(),
        Some("_id_")
    );

    let other = store
        .database()
        .run_command(doc! { "find": "events", "filter": { "$bogus": 1 } })
        .await
        .err()
        .context("bad query")?;
    assert!(!is_duplicate_key(&other));
    store.database().drop().await?;
    Ok(())
}

#[tokio::test]
async fn transaction_falls_back_on_a_standalone_server() -> Result<()> {
    let Some(uri) = uri() else { return Ok(()) };
    let config = MongoConfig {
        database: Some(test_database()),
        ..MongoConfig::new(uri)
    };
    let store = MongoStore::connect(&config, None).await?;
    let hello = store
        .client()
        .database("admin")
        .run_command(doc! { "hello": 1 })
        .await?;
    let replica_set =
        hello.contains_key("setName") || hello.get_str("msg").is_ok_and(|m| m == "isdbgrid");
    let coll = store.documents("ledger");
    let mut calls: Vec<bool> = Vec::new();
    let written = with_transaction_or_fallback(store.client(), &mut calls, |session, calls| {
        let coll = coll.clone();
        async move {
            calls.push(session.is_some());
            match session {
                Some(session) => {
                    coll.insert_one(doc! { "_id": 1, "who": "שלום" })
                        .session(session)
                        .await?
                }
                None => coll.insert_one(doc! { "_id": 1, "who": "שלום" }).await?,
            };
            Ok("done")
        }
        .boxed()
    })
    .await?;
    assert_eq!(written, "done");
    if replica_set {
        assert_eq!(calls, [true]);
    } else {
        // Standalone: as with Node's withTransaction, the operation starts in the transaction,
        // its first write is refused (code 20, "Transaction numbers are only allowed on a
        // replica set member or mongos"), and it runs again without a session
        // (follow_ledger.ts:388).
        assert_eq!(calls, [true, false]);
    }
    assert_eq!(coll.count_documents(doc! {}).await?, 1);

    // An error from the operation itself is returned, not swallowed by the fallback.
    let failed = with_transaction_or_fallback(store.client(), (), |_, _| {
        let coll = coll.clone();
        async move {
            coll.insert_one(doc! { "_id": 1 }).await?;
            Ok(())
        }
        .boxed()
    })
    .await
    .err()
    .context("duplicate _id must fail")?;
    assert!(is_duplicate_key(&failed) && !is_transaction_unsupported(&failed));
    store.database().drop().await?;
    Ok(())
}

#[tokio::test]
async fn id_filters_and_json_round_trip() -> Result<()> {
    let Some(uri) = uri() else { return Ok(()) };
    let config = MongoConfig {
        database: Some(test_database()),
        ..MongoConfig::new(uri)
    };
    let store = MongoStore::connect(&config, None).await?;
    let oids = store.documents("oids");
    let a = ObjectId::parse_str("0123456789abcdef01234567")?;
    let b = ObjectId::parse_str("0123456789abcdef01234568")?;
    oids.insert_many([
        doc! { "_id": a, "n": 1 },
        doc! { "_id": b, "n": Bson::Int64(9_007_199_254_740_993) },
    ])
    .await?;
    let filter =
        IdType::ObjectId.cast_in(["0123456789ABCDEF01234567", "0123456789abcdef01234568"])?;
    assert_eq!(oids.count_documents(doc! { "_id": filter }).await?, 2);
    assert!(
        IdType::ObjectId
            .cast_in(["0123456789abcdef01234567", "nope"])
            .is_err()
    );

    let strings = store.documents("strings");
    strings.insert_one(doc! { "_id": "c1:2026-11-11", "at": DateTime::from_millis(1_794_391_200_123), "text": "e\u{301} 👨‍👩‍👧 مرحبا" }).await?;
    let stored = strings
        .find_one(doc! { "_id": IdType::String.cast("c1:2026-11-11")? })
        .await?
        .context("string id")?;
    assert_eq!(
        read_id(&stored),
        Some(DocId::String("c1:2026-11-11".into()))
    );
    assert_eq!(
        json::to_json_string(&stored),
        "{\"_id\":\"c1:2026-11-11\",\"at\":\"2026-11-11T10:00:00.123Z\",\"text\":\"e\u{301} 👨\u{200d}👩\u{200d}👧 مرحبا\"}"
    );
    let big: Document = oids.find_one(doc! { "_id": b }).await?.context("big")?;
    assert_eq!(
        json::to_json_string(&big),
        r#"{"_id":"0123456789abcdef01234568","n":{"low":1,"high":2097152,"unsigned":false}}"#
    );
    store.database().drop().await?;
    Ok(())
}
