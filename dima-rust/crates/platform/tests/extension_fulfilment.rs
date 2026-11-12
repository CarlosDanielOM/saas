use anyhow::{Context, Result};
use bson::{Bson, Document, doc, oid::ObjectId};
use dima_core::{ManualClock, Random};
use dima_model::user_extension_inventories::INFO;
use dima_platform::extension_fulfilment::*;
use dima_store::mongo::{MongoConfig, MongoStore, WriteContext};
use futures_util::{FutureExt, TryStreamExt};
use serde_json::Value;
use std::{panic::AssertUnwindSafe, sync::Arc, time::Duration};
const NOW: i64 = 1794355200000;
fn reference() -> Result<Value> {
    Ok(serde_json::from_str(include_str!(
        "fulfilment-reference.json"
    ))?)
}
fn doc_value(v: &Value) -> Result<Document> {
    Ok(bson::deserialize_from_bson(Bson::try_from(v.clone())?)?)
}
async fn connect(db: &str) -> Result<Option<MongoStore>> {
    let uri = match std::env::var("DIMA_TEST_MONGO_URI") {
        Ok(u) => u,
        Err(e) => {
            if std::env::var("DIMA_TEST_REQUIRE_STORES").as_deref() == Ok("1") {
                return Err(e.into());
            }
            return Ok(None);
        }
    };
    let mut config = MongoConfig::new(uri);
    config.database = Some(db.into());
    Ok(Some(MongoStore::connect(&config, None).await?))
}
async fn with_store<F, Fut>(f: F) -> Result<()>
where
    F: FnOnce(MongoStore) -> Fut,
    Fut: std::future::Future<Output = Result<()>>,
{
    let db = format!(
        "dima_test_platform_{}",
        dima_core::SystemRandom.hex_token(12)?
    );
    let Some(store) = connect(&db).await? else {
        return Ok(());
    };
    let result = AssertUnwindSafe(f(store.clone())).catch_unwind().await;
    store.database().drop().await?;
    match result {
        Ok(r) => r,
        Err(p) => std::panic::resume_unwind(p),
    }
}
fn service(store: MongoStore) -> Result<Fulfilment> {
    Ok(Fulfilment::new(
        store,
        Arc::new(ManualClock::new(NOW)),
        Config::default(),
    )?)
}
async fn seed(store: &MongoStore) -> Result<()> {
    for i in INFO.indexes {
        store.documents(INFO.name).create_index(i.model()).await?;
    }
    let p = INFO.prepare_create(
        &doc_value(&reference()?["seed"])?,
        &mut WriteContext::new(NOW),
    )?;
    store.writes(INFO.name).insert_one(&p).await?;
    Ok(())
}
async fn documents(store: &MongoStore) -> Result<Value> {
    let rows: Vec<Document> = store
        .documents(INFO.name)
        .find(doc! {})
        .sort(doc! {"_id":1})
        .await?
        .try_collect()
        .await?;
    for row in &rows {
        let _: dima_model::user_extension_inventories::UserExtensionInventory =
            dima_model::decode_document(row)?;
    }
    Ok(Bson::Array(rows.into_iter().map(Bson::Document).collect()).into_canonical_extjson())
}
async fn operation(f: &Fulfilment, kind: &str) -> Result<()> {
    if kind == "refund" {
        f.refund_dimafx_once("123", "456", 12.5, "refund:one")
            .await?;
    } else {
        f.save_dimafx_purchase_once(
            "123",
            "456",
            ObjectId::parse_str("000000000000000000000002")?,
            20.0,
            "ledger-one",
        )
        .await?;
    }
    Ok(())
}
#[tokio::test]
async fn recorded_bson_and_duplicate_delivery() -> Result<()> {
    with_store(|store| async move {
        let r = reference()?;
        assert_eq!(
            r["sha256"],
            dima_core::crypto::digest::sha256(include_str!(
                "../../../../dimabot/src/server/services/dimafx-fulfillment.service.ts"
            ))
            .hex()
        );
        seed(&store).await?;
        assert_eq!(documents(&store).await?, r["initial"]);
        let f = service(store.clone())?;
        for step in r["steps"].as_array().context("steps")? {
            let kind = step["kind"].as_str().context("kind")?;
            let user = if kind.starts_with("missing") {
                "absent"
            } else {
                "456"
            };
            let amount = step["amount"].as_f64().context("amount")?;
            let key = step["key"].as_str().context("key")?;
            let result = if kind.ends_with("refund") {
                f.refund_dimafx_once("123", user, amount, key).await
            } else {
                f.save_dimafx_purchase_once(
                    "123",
                    user,
                    ObjectId::parse_str("000000000000000000000002")?,
                    amount,
                    key,
                )
                .await
                .map(|_| ())
            };
            assert_eq!(
                result.err().map(|e| e.to_string()),
                step["error"].as_str().map(str::to_owned)
            );
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
async fn cancel_after_committed_write_then_repeat() -> Result<()> {
    for kind in ["refund", "save"] {
        with_store(|store| async move {
            seed(&store).await?;
            let f = service(store.clone())?;
            let signal = Arc::new(tokio::sync::Notify::new());
            let s = signal.clone();
            let interrupted = f.clone().with_after_write_hook(Arc::new(move || {
                let s = s.clone();
                Box::pin(async move {
                    s.notify_one();
                    std::future::pending().await
                })
            }));
            let task = tokio::spawn(async move { operation(&interrupted, kind).await });
            tokio::time::timeout(Duration::from_secs(10), signal.notified()).await?;
            task.abort();
            assert!(task.await.is_err_and(|e| e.is_cancelled()));
            let once = documents(&store).await?;
            operation(&f, kind).await?;
            assert_eq!(once, documents(&store).await?);
            assert_eq!(once, reference()?["singleEffects"][kind]);
            Ok(())
        })
        .await?;
    }
    Ok(())
}
#[tokio::test]
async fn process_worker() -> Result<()> {
    let Ok(db) = std::env::var("DIMA_PLATFORM_FULFILMENT_CHILD_DB") else {
        return Ok(());
    };
    if !db.starts_with("dima_test_platform_") {
        anyhow::bail!("unsafe child database");
    }
    let kind = std::env::var("DIMA_PLATFORM_FULFILMENT_CHILD_KIND")?;
    let store = connect(&db).await?.context("store")?;
    // The parent releases both child processes through their stdin after both have started.
    use tokio::io::AsyncReadExt;
    println!("READY");
    let mut start = [0u8; 1];
    tokio::io::stdin().read_exact(&mut start).await?;
    operation(&service(store)?, &kind).await
}
#[tokio::test]
async fn two_processes_apply_once() -> Result<()> {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;
    for kind in ["refund", "save"] {
        with_store(|store| async move {
            seed(&store).await?;
            let exe = std::env::current_exe()?;
            let mut children = Vec::new();
            for _ in 0..2 {
                let child = tokio::process::Command::new(&exe)
                    .args(["--exact", "process_worker", "--nocapture"])
                    .env("DIMA_PLATFORM_FULFILMENT_CHILD_DB", store.database().name())
                    .env("DIMA_PLATFORM_FULFILMENT_CHILD_KIND", kind)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .kill_on_drop(true)
                    .spawn()?;
                let mut child = child;
                let stdout = child.stdout.take().context("stdout")?;
                let mut reader = tokio::io::BufReader::new(stdout);
                use tokio::io::AsyncBufReadExt;
                tokio::time::timeout(Duration::from_secs(10), async {
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).await? == 0 {
                            anyhow::bail!("worker exited before ready");
                        }
                        if line.trim() == "READY" {
                            break;
                        }
                    }
                    Ok::<_, anyhow::Error>(())
                })
                .await??;
                child.stdout = Some(reader.into_inner());
                children.push(child);
            }
            for child in &mut children {
                child
                    .stdin
                    .as_mut()
                    .context("stdin")?
                    .write_all(b"g")
                    .await?;
            }
            let b = children.pop().context("child")?;
            let a = children.pop().context("child")?;
            let (a, b) = tokio::try_join!(
                async {
                    Ok::<_, anyhow::Error>(
                        tokio::time::timeout(Duration::from_secs(20), a.wait_with_output())
                            .await??,
                    )
                },
                async {
                    Ok::<_, anyhow::Error>(
                        tokio::time::timeout(Duration::from_secs(20), b.wait_with_output())
                            .await??,
                    )
                }
            )?;
            assert!(a.status.success(), "{}", String::from_utf8_lossy(&a.stderr));
            assert!(b.status.success(), "{}", String::from_utf8_lossy(&b.stderr));
            let raced = documents(&store).await?;
            let f = service(store.clone())?;
            operation(&f, kind).await?;
            assert_eq!(raced, documents(&store).await?);
            assert_eq!(raced, reference()?["singleEffects"][kind]);
            Ok(())
        })
        .await?;
    }
    Ok(())
}
