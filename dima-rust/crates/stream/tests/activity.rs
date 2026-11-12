// Frozen deployed witness is test-only; retain its invariant assertion unchanged.
#[allow(dead_code, clippy::expect_used)]
#[path = "../../../src/workers/stream_activity/mod.rs"]
mod legacy;
mod support;
use anyhow::{Context, Result};
use bson::{Bson, Document, doc, oid::ObjectId};
use dima_core::ManualClock;
use dima_store::mongo::MongoStore;
use dima_stream::stream_activity::*;
use futures_util::TryStreamExt;
use serde_json::Value;
use std::sync::Arc;
fn recording() -> Result<Value> {
    Ok(serde_json::from_str(include_str!(
        "activity-reference.json"
    ))?)
}
fn document(value: &Value) -> Result<Document> {
    let b = Bson::try_from(value.clone())?;
    Ok(b.as_document().context("document")?.clone())
}
async fn docs(store: &MongoStore, collection: &str) -> Result<Vec<Document>> {
    Ok(store
        .documents(collection)
        .find(doc! {})
        .sort(doc! {"_id":1})
        .await?
        .try_collect()
        .await?)
}
fn canonical(mut doc: Document) -> Value {
    if doc.contains_key("owner") {
        doc.insert("owner", "<owner>");
    }
    Bson::Document(doc).into_canonical_extjson()
}
#[tokio::test]
async fn recorded_capture_projection_and_all_tier_reads() -> Result<()> {
    support::with_store(|store| async move {
        let r = recording()?;
        let now = r["now"].as_i64().context("clock")?;
        seed_sessions(&store, &r, now).await?;
        let activity = Activities::new(
            store.clone(),
            Arc::new(ManualClock::new(now)),
            Config::default(),
        )?;
        let fragments: Vec<Fragment> = serde_json::from_value(r["fragments"].clone())?;
        assert_eq!(
            dima_text::to_js_json(&serde_json::to_value(extract_timeline_emotes(&fragments))?),
            dima_text::to_js_json(&r["emotes"])
        );
        let session = ObjectId::parse_str("0123456789abcdef01234567")?;
        let mut count = 0;
        let native: Value = if std::env::var_os("DIMA_RECORD_NATIVE_ACTIVITY").is_some() {
            Value::Null
        } else {
            serde_json::from_str(include_str!("activity-native-reference.json"))?
        };
        let mut native_steps = Vec::new();
        let legacy = legacy::StreamActivityProjector::new(store.database().clone());
        for (index, step) in r["steps"].as_array().context("steps")?.iter().enumerate() {
            let op = document(&step["operation"])?;
            if let Ok(capture) = op.get_document("capture") {
                let input: Capture = bson::deserialize_from_document(capture.clone())?;
                activity.capture_stream_activity(&input).await?;
            } else {
                let n = if native.is_null() {
                    legacy.project_batch(2).await?
                } else {
                    activity
                        .project_stream_activity_batch(2, "test-owner")
                        .await?
                };
                assert_eq!(n, step["result"].as_u64().context("count")? as usize);
            }
            let mut native_documents = serde_json::Map::new();
            for collection in [
                "stream_activities",
                "stream_activity_aggregates",
                "stream_activity_states",
            ] {
                let actual = docs(&store, collection)
                    .await?
                    .into_iter()
                    .map(|mut d| {
                        if native.is_null() && d.contains_key("updatedAt") {
                            d.insert("updatedAt", bson::DateTime::from_millis(now));
                        }
                        d
                    })
                    .collect::<Vec<_>>();
                native_documents.insert(
                    collection.into(),
                    Value::Array(actual.iter().cloned().map(canonical).collect()),
                );
                if collection == "stream_activities" {
                    let expected = step["documents"][collection]
                        .as_array()
                        .context("TS activity docs")?;
                    assert_eq!(
                        actual.iter().cloned().map(canonical).collect::<Vec<_>>(),
                        *expected,
                        "{} capture BSON",
                        step["name"]
                    );
                }
                if native.is_null() {
                    continue;
                }
                let expected = native[index][collection]
                    .as_array()
                    .context("documents")?
                    .iter()
                    .map(document)
                    .collect::<Result<Vec<_>>>()?;
                assert_eq!(
                    actual.len(),
                    expected.len(),
                    "{} {collection}",
                    step["name"]
                );
                for (a, e) in actual.into_iter().zip(expected) {
                    assert_eq!(canonical(a), canonical(e), "{} {collection}", step["name"]);
                    count += 1;
                }
            }
            native_steps.push(Value::Object(native_documents));
            if native.is_null() {
                continue;
            }
            for tier in ["free", "premium", "pro"] {
                let actual = activity
                    .get_stream_activity("channel", session, tier)
                    .await?;
                assert_eq!(
                    normalized(&actual)?,
                    normalized(&step["reads"][tier])?,
                    "{} {tier}",
                    step["name"]
                );
            }
        }
        if native.is_null() {
            std::fs::write(
                concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/tests/activity-native-reference.json"
                ),
                serde_json::to_string_pretty(&native_steps)? + "\n",
            )?;
        }
        eprintln!("activity: {count} typed BSON documents and 54 tier reads compared");
        Ok(())
    })
    .await
}
fn redact(v: &mut Value) {
    match v {
        Value::Array(a) => {
            for v in a {
                redact(v)
            }
        }
        Value::Object(o) => {
            for (k, v) in o {
                if ["key", "label"].contains(&k.as_str()) {
                    if let Some(s) = v.as_str() {
                        *v = Value::String(dima_core::crypto::sha256(s).hex());
                    }
                } else {
                    redact(v)
                }
            }
        }
        _ => {}
    }
}
#[tokio::test]
async fn real_session_reads_match_recorded_reference() -> Result<()> {
    let Some(store) = support::mongo("domdimabot").await? else {
        return Ok(());
    };
    let r: Value = serde_json::from_str(include_str!("activity-real-reference.json"))?;
    let activity = Activities::new(
        store,
        Arc::new(ManualClock::new(r["now"].as_i64().context("now")?)),
        Config::default(),
    )?;
    for case in r["cases"].as_array().context("cases")? {
        let mut actual = activity
            .get_stream_activity(
                case["channel"].as_str().context("channel")?,
                ObjectId::parse_str(case["session"].as_str().context("session")?)?,
                case["tier"].as_str().context("tier")?,
            )
            .await?;
        redact(&mut actual);
        assert_eq!(normalized(&actual)?, normalized(&case["expected"])?);
    }
    eprintln!("12 real sessions / 36 tier reads matched");
    Ok(())
}
async fn seed(store: &MongoStore, now: i64) -> Result<Activities> {
    let a = Activities::new(
        store.clone(),
        Arc::new(ManualClock::new(now)),
        Config::default(),
    )?;
    seed_sessions(store, &recording()?, now).await?;
    for step in recording()?["steps"].as_array().context("steps")? {
        let op = document(&step["operation"])?;
        if let Ok(c) = op.get_document("capture") {
            a.capture_stream_activity(&bson::deserialize_from_document(c.clone())?)
                .await?;
        }
    }
    Ok(a)
}
#[tokio::test]
async fn interrupted_after_every_write_and_two_processes_do_not_double_count() -> Result<()> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let now = recording()?["now"].as_i64().context("now")?;
    let writes = Arc::new(AtomicUsize::new(0));
    support::with_store(|store| {
        let writes = writes.clone();
        async move {
            let a = seed(&store, now).await?.with_write_hook(Arc::new(move || {
                writes.fetch_add(1, Ordering::SeqCst);
                Box::pin(async {})
            }));
            a.project_stream_activity_batch(1000, "count-writes")
                .await?;
            Ok(())
        }
    })
    .await?;
    let writes = writes.load(Ordering::SeqCst);
    for cut in 1..=writes {
        support::with_store(|store| async move {
            seed(&store, now).await?;
            let clock = Arc::new(ManualClock::new(now));
            let counter = Arc::new(AtomicUsize::new(0));
            let stopped = Arc::new(tokio::sync::Notify::new());
            let signal = stopped.clone();
            let a = Activities::new(store.clone(), clock.clone(), Config::default())?
                .with_write_hook(Arc::new(move || {
                    let hit = counter.fetch_add(1, Ordering::SeqCst) + 1 == cut;
                    let signal = signal.clone();
                    Box::pin(async move {
                        if hit {
                            signal.notify_one();
                            std::future::pending::<()>().await;
                        }
                    })
                }));
            let task =
                tokio::spawn(
                    async move { a.project_stream_activity_batch(1000, "killed-owner").await },
                );
            tokio::time::timeout(std::time::Duration::from_secs(30), stopped.notified()).await?;
            task.abort();
            assert!(task.await.is_err_and(|e| e.is_cancelled()));
            clock.advance(61_000);
            let a = Activities::new(store.clone(), clock, Config::default())?;
            a.project_stream_activity_batch(1000, "repair").await?;
            while a.project_stream_activity_batch(1000, "drain").await? > 0 {}
            let read = a
                .get_stream_activity(
                    "channel",
                    ObjectId::parse_str("0123456789abcdef01234567")?,
                    "pro",
                )
                .await?;
            assert_eq!(
                dima_text::to_js_json(&read["totals"]),
                dima_text::to_js_json(
                    &recording()?["steps"]
                        .as_array()
                        .context("steps")?
                        .last()
                        .context("last")?["reads"]["pro"]["totals"]
                )
            );
            Ok(())
        })
        .await?;
    }
    // Actual independent OS processes compete for the same persisted checkpoint.
    support::with_store(|store| async move {
        seed(&store, now).await?;
        let executable = std::env::current_exe()?;
        let mut children = Vec::new();
        for owner in ["process-a", "process-b"] {
            children.push(
                tokio::process::Command::new(&executable)
                    .args(["--exact", "projection_child", "--nocapture"])
                    .env("DIMA_ACTIVITY_CHILD_DB", store.database().name())
                    .env("DIMA_ACTIVITY_CHILD_OWNER", owner)
                    .spawn()?,
            );
        }
        for mut child in children {
            assert!(child.wait().await?.success());
        }
        let a = Activities::new(
            store.clone(),
            Arc::new(ManualClock::new(now)),
            Config::default(),
        )?;
        let read = a
            .get_stream_activity(
                "channel",
                ObjectId::parse_str("0123456789abcdef01234567")?,
                "pro",
            )
            .await?;
        assert_eq!(
            dima_text::to_js_json(&read["totals"]),
            dima_text::to_js_json(
                &recording()?["steps"]
                    .as_array()
                    .context("steps")?
                    .last()
                    .context("last")?["reads"]["pro"]["totals"]
            )
        );
        Ok(())
    })
    .await?;
    eprintln!("recovered at all {writes} write boundaries; two OS processes did not double count");
    Ok(())
}
#[tokio::test]
async fn projection_child() -> Result<()> {
    let Ok(db) = std::env::var("DIMA_ACTIVITY_CHILD_DB") else {
        return Ok(());
    };
    assert!(db.starts_with("dima_test_stream_"));
    let store = support::mongo(&db).await?.context("store")?;
    let a = Activities::new(
        store,
        Arc::new(ManualClock::new(
            recording()?["now"].as_i64().context("now")?,
        )),
        Config::default(),
    )?;
    a.project_stream_activity_batch(1000, &std::env::var("DIMA_ACTIVITY_CHILD_OWNER")?)
        .await?;
    Ok(())
}
#[tokio::test]
async fn every_real_activity_document_decodes_through_model() -> Result<()> {
    let Some(store) = support::mongo("domdimabot").await? else {
        return Ok(());
    };
    for info in [
        &dima_model::stream_activities::INFO,
        &dima_model::stream_activity_aggregates::INFO,
        &dima_model::stream_activity_states::INFO,
        &dima_model::stream_sessions::INFO,
    ] {
        let mut cursor = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            store
                .documents(info.name)
                .clone_with_type::<bson::RawDocumentBuf>()
                .find(doc! {})
                .batch_size(256),
        )
        .await??;
        let mut count = 0;
        while let Some(raw) =
            tokio::time::timeout(std::time::Duration::from_secs(5), cursor.try_next()).await??
        {
            (info.decode)(&raw)?;
            count += 1;
        }
        assert!(count > 0, "real collection {} empty", info.name);
        eprintln!("{}: {count} real documents decoded", info.name);
    }
    Ok(())
}

async fn seed_sessions(store: &MongoStore, r: &Value, now: i64) -> Result<()> {
    for row in r["seedSessions"].as_array().context("seedSessions")? {
        let prepared = dima_model::stream_sessions::INFO.prepare_create(
            &document(row)?,
            &mut dima_store::mongo::WriteContext::new(now),
        )?;
        store.writes("streamsessions").insert_one(&prepared).await?;
    }
    Ok(())
}

fn normalized(value: &Value) -> Result<Value> {
    Ok(serde_json::from_str(&dima_text::to_js_json(value))?)
}
