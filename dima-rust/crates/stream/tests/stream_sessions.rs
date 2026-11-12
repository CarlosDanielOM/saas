mod support;
use anyhow::{Context, Result};
use bson::{Bson, Document, doc, oid::ObjectId};
use dima_core::ManualClock;
use dima_events::consumer::handler::Outcome;
use dima_model::CollectionInfo;
use dima_store::mongo::MongoStore;
use dima_stream::stream_sessions::*;
use futures_util::TryStreamExt;
use serde_json::{Value, json};
use std::sync::Arc;
const NOW: i64 = 1794355200000;
const COLLECTIONS: [&CollectionInfo; 3] = [
    &dima_model::stream_sessions::INFO,
    &dima_model::stream_participants::INFO,
    &dima_model::stream_activities::INFO,
];
fn recording() -> Result<Value> {
    Ok(serde_json::from_str(include_str!(
        "stream-sessions-reference.json"
    ))?)
}
fn document(v: &Value) -> Result<Document> {
    Ok(Bson::try_from(v.clone())?
        .as_document()
        .context("document")?
        .clone())
}
fn sessions(store: MongoStore) -> Result<StreamSessions> {
    Ok(StreamSessions::new(store, Arc::new(ManualClock::new(NOW)))?)
}
async fn seed(store: &MongoStore, r: &Value) -> Result<()> {
    for info in COLLECTIONS {
        // Raw reference BSON is an existing stored document, including an unknown field.
        for row in r["seed"][info.name].as_array().context("seed")? {
            store
                .documents(info.name)
                .insert_one(document(row)?)
                .await?;
        }
        for spec in info.indexes {
            store
                .documents(info.name)
                .create_index(spec.model())
                .await?;
        }
    }
    Ok(())
}
async fn snapshot(store: &MongoStore) -> Result<Value> {
    let mut out = serde_json::Map::new();
    for info in COLLECTIONS {
        let rows: Vec<Document> = store
            .documents(info.name)
            .find(doc! {})
            .await?
            .try_collect()
            .await?;
        let mut values = Vec::new();
        for mut row in rows {
            (info.decode)(&bson::RawDocumentBuf::try_from(&row)?)?;
            if info.name == "stream_participants" {
                row.insert("_id", ObjectId::from_bytes([0; 12]));
            }
            values.push(Bson::Document(row).into_canonical_extjson());
        }
        values.sort_by_key(|v| {
            if info.name == "stream_participants" {
                json!([v["user_id"], v["bucket"]]).to_string()
            } else {
                v["_id"].to_string()
            }
        });
        out.insert(info.name.into(), Value::Array(values));
    }
    Ok(Value::Object(out))
}
async fn apply(s: &StreamSessions, step: &Value) -> Result<Value> {
    let input = step["input"].clone();
    let special = input["special"].as_str().map(dima_text::parse_number);
    let mut metric: MetricEvent = serde_json::from_value(input.clone())?;
    let mut count: CountEvent = serde_json::from_value(input.clone())?;
    let mut message: MessageEvent = serde_json::from_value(input.clone())?;
    if let Some(value) = special {
        metric.quantity = Some(value);
        count.quantity = Some(value);
        message.count.quantity = Some(value);
    }
    let outcome = match step["kind"].as_str().context("kind")? {
        "bits" => s.record_stream_bits_event(&metric).await,
        "sub" => s.record_stream_sub_event(&metric).await,
        "follow" => s.record_stream_follow_event(&metric).await,
        "donation" => {
            s.record_stream_donation_event(
                input["channelID"].as_str().context("channel")?,
                special.or_else(|| input["quantity"].as_f64()),
            )
            .await?;
            Ok(())
        }
        "command" => {
            s.record_stream_command_event(&count).await?;
            Ok(())
        }
        "message" => {
            s.record_stream_message_event(&message).await?;
            Ok(())
        }
        kind => anyhow::bail!("unexpected kind {kind}"),
    };
    match outcome {
        Ok(()) => Ok(Value::Null),
        Err(Outcome::MissingPrerequisite(p)) => Ok(json!({"prerequisite":p})),
        Err(e) => anyhow::bail!("unexpected {e:?}"),
    }
}
#[tokio::test]
async fn recorded_session_recorders_exact_bson() -> Result<()> {
    support::with_store(|store| async move {
        let r = recording()?;
        seed(&store, &r).await?;
        let s = sessions(store.clone())?;
        for step in r["steps"].as_array().context("steps")? {
            assert_eq!(apply(&s, step).await?, step["result"], "{}", step["name"]);
            assert_eq!(
                snapshot(&store).await?,
                step["documents"],
                "{}",
                step["name"]
            );
        }
        Ok(())
    })
    .await
}
#[tokio::test]
async fn real_session_read_types_decode() -> Result<()> {
    let Some(store) = support::mongo("domdimabot").await? else {
        return Ok(());
    };
    let rows: Vec<Document> = store
        .documents("streamsessions")
        .find(doc! {})
        .sort(doc! {"started_at":-1})
        .limit(100)
        .await?
        .try_collect()
        .await?;
    assert!(!rows.is_empty());
    for row in &rows {
        (dima_model::stream_sessions::INFO.decode)(&bson::RawDocumentBuf::try_from(row)?)?;
    }
    eprintln!("decoded {} real sessions, read-only", rows.len());
    Ok(())
}
#[tokio::test]
async fn cancellation_receipts_and_message_double_counts() -> Result<()> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let r = recording()?;
    for (name, writes) in [
        ("bits-key", 1),
        ("sub-key", 1),
        ("follow-key", 1),
        ("participant", 3),
        ("capture", 2),
    ] {
        for cut in 1..=writes {
            let r = r.clone();
            support::with_store(|store| async move {
                seed(&store, &r).await?;
                let s = sessions(store.clone())?;
                let steps = r["steps"].as_array().context("steps")?;
                let index = steps
                    .iter()
                    .position(|v| v["name"] == name)
                    .context("step")?;
                for step in &steps[..index] {
                    apply(&s, step).await?;
                }
                let signal = Arc::new(tokio::sync::Notify::new());
                let notify = signal.clone();
                let count = Arc::new(AtomicUsize::new(0));
                let fault = sessions(store.clone())?.with_write_hook(Arc::new(move || {
                    let hit = count.fetch_add(1, Ordering::SeqCst) + 1 == cut;
                    let notify = notify.clone();
                    Box::pin(async move {
                        if hit {
                            notify.notify_one();
                            std::future::pending::<()>().await;
                        }
                    })
                }));
                let step = steps[index].clone();
                let child = tokio::spawn(async move { apply(&fault, &step).await });
                // Bounds a confirmed-write notification, not a scheduling assumption.
                let observed =
                    tokio::time::timeout(std::time::Duration::from_secs(60), signal.notified())
                        .await;
                child.abort();
                let joined = child.await;
                observed?;
                assert!(joined.is_err_and(|e| e.is_cancelled()));
                apply(&s, &steps[index]).await?;
                // Keyed metrics apply once; legacy message counters apply twice, while
                // participant and activity identities remain deduplicated.
                assert_eq!(
                    snapshot(&store).await?,
                    steps[index + 1]["documents"],
                    "{name} write {cut}"
                );
                Ok(())
            })
            .await?;
        }
    }
    Ok(())
}
#[tokio::test]
async fn two_processes_same_key() -> Result<()> {
    support::with_store(|store| async move {
        let r = recording()?;
        seed(&store, &r).await?;
        let s = sessions(store.clone())?;
        let steps = r["steps"].as_array().context("steps")?;
        let index = steps
            .iter()
            .position(|v| v["name"] == "bits-key")
            .context("key step")?;
        for step in &steps[..index] {
            apply(&s, step).await?;
        }
        let mut children = Vec::new();
        for _ in 0..2 {
            children.push(
                tokio::process::Command::new(std::env::current_exe()?)
                    .args(["--exact", "recorder_process_child", "--nocapture"])
                    .env("DIMA_SESSION_RECORDERS_CHILD", store.database().name())
                    .kill_on_drop(true)
                    .spawn()?,
            );
        }
        let barrier = store.documents("recorder_test_barrier");
        tokio::time::timeout(std::time::Duration::from_secs(60), async {
            loop {
                if barrier.count_documents(doc! {"ready":true}).await? == 2 {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            Ok::<(), mongodb::error::Error>(())
        })
        .await??;
        barrier.insert_one(doc! {"_id":"release"}).await?;
        for mut child in children {
            assert!(
                tokio::time::timeout(std::time::Duration::from_secs(60), child.wait())
                    .await??
                    .success()
            );
        }
        assert_eq!(snapshot(&store).await?, steps[index]["documents"]);
        Ok(())
    })
    .await
}
#[tokio::test]
async fn recorder_process_child() -> Result<()> {
    let Ok(database) = std::env::var("DIMA_SESSION_RECORDERS_CHILD") else {
        return Ok(());
    };
    assert!(database.starts_with("dima_test_stream_"));
    let store = support::mongo(&database).await?.context("store")?;
    let barrier = store.documents("recorder_test_barrier");
    barrier
        .insert_one(doc! {"_id":i64::from(std::process::id()),"ready":true})
        .await?;
    tokio::time::timeout(std::time::Duration::from_secs(60), async {
        loop {
            if barrier.find_one(doc! {"_id":"release"}).await?.is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        Ok::<(), mongodb::error::Error>(())
    })
    .await??;
    let r = recording()?;
    let step = r["steps"]
        .as_array()
        .context("steps")?
        .iter()
        .find(|v| v["name"] == "bits-key")
        .context("key")?;
    apply(&sessions(store)?, step).await?;
    Ok(())
}
