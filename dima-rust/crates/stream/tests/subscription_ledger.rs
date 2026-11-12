mod support;
use anyhow::{Context, Result};
use bson::{Bson, Document, doc};
use dima_core::ManualClock;
use dima_model::stream_subscription_ledgers::INFO;
use dima_store::mongo::{MongoStore, WriteContext};
use dima_stream::subscription_ledger::*;
use futures_util::TryStreamExt;
use serde_json::Value;
use std::sync::Arc;
fn recording() -> Result<Value> {
    Ok(serde_json::from_str(include_str!(
        "subscription-ledger-reference.json"
    ))?)
}
fn document(v: &Value) -> Result<Document> {
    Ok(Bson::try_from(v.clone())?
        .as_document()
        .context("document")?
        .clone())
}
async fn documents(store: &MongoStore) -> Result<Value> {
    let rows: Vec<Document> = store
        .documents(INFO.name)
        .find(doc! {})
        .sort(doc! {"user_id":1,"subbed_at":1,"_id":1})
        .await?
        .try_collect()
        .await?;
    Ok(Value::Array(
        rows.into_iter()
            .map(|mut d| {
                d.insert("_id", bson::oid::ObjectId::from_bytes([0; 12]));
                Bson::Document(d).into_canonical_extjson()
            })
            .collect(),
    ))
}
fn ledger(store: MongoStore) -> Result<SubscriptionLedger> {
    Ok(SubscriptionLedger::new(
        store,
        Arc::new(ManualClock::new(1794355200000)),
        Config::default(),
    )?)
}
async fn indexes(store: &MongoStore) -> Result<()> {
    for index in INFO.indexes {
        store
            .documents(INFO.name)
            .create_index(index.model())
            .await?;
    }
    Ok(())
}
#[tokio::test]
async fn recorded_typed_bson_replay() -> Result<()> {
    support::with_store(|store| async move {
        indexes(&store).await?;
        let r = recording()?;
        let ledger = ledger(store.clone())?;
        for step in r["steps"].as_array().context("steps")? {
            if !step["seed"].is_null() {
                let p = INFO.prepare_create(
                    &document(&step["seed"])?,
                    &mut WriteContext::new(1794355200000),
                )?;
                store.writes(INFO.name).insert_one(&p).await?;
            }
            let input = document(&step["input"])?;
            if step["kind"] == "start" {
                ledger
                    .record_subscription_ledger_start(&bson::deserialize_from_document(input)?)
                    .await?;
            } else {
                ledger
                    .record_subscription_ledger_end(&bson::deserialize_from_document(input)?)
                    .await?;
            }
            assert_eq!(
                documents(&store).await?,
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
async fn cancel_after_each_single_write_and_replay() -> Result<()> {
    for (kind, user) in [
        ("start", "new"),
        ("start", "active"),
        ("start", "ended"),
        ("end", "new"),
        ("end", "active"),
        ("end", "ended"),
    ] {
        support::with_store(|store| async move {
            indexes(&store).await?;
            let a = ledger(store.clone())?;
            let start = Start {
                streamer_id: "channel".into(),
                user_id: user.into(),
                event_key: Some("seed".into()),
                ..Start::default()
            };
            if user != "new" {
                a.record_subscription_ledger_start(&start).await?;
            }
            if user == "ended" {
                a.record_subscription_ledger_end(&End {
                    streamer_id: "channel".into(),
                    user_id: user.into(),
                    event_key: Some("seed-end".into()),
                    ..End::default()
                })
                .await?;
            }
            let start = Start {
                event_key: Some("event".into()),
                subbed_at: Some(bson::DateTime::from_millis(1794355200001)),
                ..start
            };
            let end = End {
                streamer_id: "channel".into(),
                user_id: user.into(),
                event_key: Some("event".into()),
                ended_at: start.subbed_at,
            };
            let signal = Arc::new(tokio::sync::Notify::new());
            let s = signal.clone();
            let interrupted = a.clone().with_write_hook(Arc::new(move |after| {
                let s = s.clone();
                Box::pin(async move {
                    if after {
                        s.notify_one();
                        std::future::pending::<()>().await;
                    }
                })
            }));
            let cstart = start.clone();
            let cend = end.clone();
            let task = tokio::spawn(async move {
                if kind == "start" {
                    interrupted.record_subscription_ledger_start(&cstart).await
                } else {
                    interrupted.record_subscription_ledger_end(&cend).await
                }
            });
            tokio::time::timeout(std::time::Duration::from_secs(10), signal.notified()).await?;
            task.abort();
            assert!(task.await.is_err_and(|e| e.is_cancelled()));
            let once = documents(&store).await?;
            if kind == "start" {
                a.record_subscription_ledger_start(&start).await?;
            } else {
                a.record_subscription_ledger_end(&end).await?;
            }
            assert_eq!(documents(&store).await?, once);
            Ok(())
        })
        .await?;
    }
    Ok(())
}
#[tokio::test]
async fn ledger_race_child() -> Result<()> {
    use std::io::Read;
    let Ok(db) = std::env::var("DIMA_LEDGER_CHILD_DB") else {
        return Ok(());
    };
    assert!(db.starts_with("dima_test_stream_"));
    let key = std::env::var("DIMA_LEDGER_CHILD_KEY")?;
    let a =
        ledger(support::mongo(&db).await?.context("store")?)?.with_write_hook(Arc::new(|after| {
            Box::pin(async move {
                if !after {
                    println!("LEDGER_READY");
                    let _ = tokio::task::spawn_blocking(|| {
                        let mut b = [0];
                        std::io::stdin().read_exact(&mut b)
                    })
                    .await;
                }
            })
        }));
    let result = a
        .record_subscription_ledger_start(&Start {
            streamer_id: "channel".into(),
            user_id: "race".into(),
            event_key: Some(key),
            ..Start::default()
        })
        .await;
    match result {
        Ok(()) => println!("LEDGER_OK"),
        Err(e) => {
            assert!(e.to_string().contains("E11000"));
            println!("LEDGER_DUPLICATE");
        }
    }
    Ok(())
}
#[tokio::test]
async fn two_process_races_with_declared_unique_indexes() -> Result<()> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    for active in [false, true] {
        for same in [true, false] {
            support::with_store(|store| async move {
                indexes(&store).await?;
                if active {
                    ledger(store.clone())?
                        .record_subscription_ledger_start(&Start {
                            streamer_id: "channel".into(),
                            user_id: "race".into(),
                            event_key: Some("seed".into()),
                            ..Start::default()
                        })
                        .await?;
                }
                let mut children = Vec::new();
                for key in ["a", if same { "a" } else { "b" }] {
                    let mut child = tokio::process::Command::new(std::env::current_exe()?)
                        .args(["--exact", "ledger_race_child", "--nocapture"])
                        .env("DIMA_LEDGER_CHILD_DB", store.database().name())
                        .env("DIMA_LEDGER_CHILD_KEY", key)
                        .kill_on_drop(true)
                        .stdin(std::process::Stdio::piped())
                        .stdout(std::process::Stdio::piped())
                        .spawn()?;
                    let mut reader = BufReader::new(child.stdout.take().context("stdout")?).lines();
                    tokio::time::timeout(std::time::Duration::from_secs(15), async {
                        while let Some(line) = reader.next_line().await? {
                            if line == "LEDGER_READY" {
                                return Ok::<_, anyhow::Error>(());
                            }
                        }
                        anyhow::bail!("child exited before barrier")
                    })
                    .await??;
                    children.push((child, reader));
                }
                for (child, _) in &mut children {
                    child
                        .stdin
                        .as_mut()
                        .context("stdin")?
                        .write_all(b"x")
                        .await?;
                }
                let mut duplicates = 0;
                for (mut child, mut reader) in children {
                    while let Some(line) = reader.next_line().await? {
                        if line == "LEDGER_DUPLICATE" {
                            duplicates += 1;
                        }
                    }
                    assert!(child.wait().await?.success());
                }
                let rows = documents(&store).await?;
                let rows = rows.as_array().context("rows")?;
                assert_eq!(rows.len(), 1);
                let keys = rows[0]["applied_event_keys"]
                    .as_array()
                    .context("history")?;
                assert_eq!(
                    keys.len(),
                    if active { if same { 2 } else { 3 } } else { 1 }
                );
                assert_eq!(duplicates, usize::from(!active && !same));
                if duplicates == 1 {
                    let key = if keys.contains(&Value::String("a".into())) {
                        "b"
                    } else {
                        "a"
                    };
                    ledger(store.clone())?
                        .record_subscription_ledger_start(&Start {
                            streamer_id: "channel".into(),
                            user_id: "race".into(),
                            event_key: Some(key.into()),
                            ..Start::default()
                        })
                        .await?;
                    let repaired = documents(&store).await?;
                    assert_eq!(
                        repaired[0]["applied_event_keys"]
                            .as_array()
                            .context("repaired keys")?
                            .len(),
                        2
                    );
                }
                Ok(())
            })
            .await?;
        }
    }
    Ok(())
}
#[tokio::test]
async fn reference_timeout_after_commit_results() -> Result<()> {
    let r = recording()?;
    for fault in r["faults"].as_array().context("faults")? {
        support::with_store(|store| async move {
            indexes(&store).await?;
            let a = ledger(store.clone())?;
            let mut start = Start {
                streamer_id: "fault".into(),
                user_id: "fault".into(),
                event_key: Some("seed".into()),
                subbed_at: Some(bson::DateTime::from_millis(1794355199999)),
                ..Start::default()
            };
            let mut end = End {
                streamer_id: "fault".into(),
                user_id: "fault".into(),
                event_key: Some("seed-end".into()),
                ended_at: start.subbed_at,
            };
            if fault["existing"] != "new" {
                a.record_subscription_ledger_start(&start).await?;
            }
            if fault["existing"] == "ended" {
                a.record_subscription_ledger_end(&end).await?;
            }
            start.event_key = Some("fault".into());
            start.subbed_at = Some(bson::DateTime::from_millis(1794355200000));
            end.event_key = start.event_key.clone();
            end.ended_at = start.subbed_at;
            for expected in [&fault["once"], &fault["replay"]] {
                if fault["kind"] == "start" {
                    a.record_subscription_ledger_start(&start).await?;
                } else {
                    a.record_subscription_ledger_end(&end).await?;
                }
                assert_eq!(&documents(&store).await?, expected, "{fault}");
            }
            Ok(())
        })
        .await?;
    }
    Ok(())
}
#[test]
fn reference_races_expose_creation_conflict() -> Result<()> {
    for race in recording()?["races"].as_array().context("races")? {
        let conflicts = race["results"]
            .as_array()
            .context("results")?
            .iter()
            .filter(|v| v.is_number())
            .count();
        assert_eq!(
            conflicts,
            usize::from(race["active"] == false && race["same"] == false)
        );
        let keys = race["documents"][0]["applied_event_keys"]
            .as_array()
            .context("keys")?;
        assert_eq!(
            keys.len(),
            if race["active"] == true {
                if race["same"] == true { 2 } else { 3 }
            } else {
                1
            }
        );
    }
    Ok(())
}
