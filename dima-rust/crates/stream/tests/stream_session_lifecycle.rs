#![allow(clippy::unwrap_used)]
mod support;
use anyhow::{Context, Result, ensure};
use bson::{Bson, Document, doc, oid::ObjectId};
use dima_core::{ManualClock, Random, RandomError};
use dima_events::{
    jobs::{DragonflyQueue, DurableJobs, JobQueue, JobsConfig},
    store::StoreError,
};
use dima_model::CollectionInfo;
use dima_store::{
    dragonfly::{Dragonfly, QueueItem},
    mongo::MongoStore,
};
use dima_stream::{
    clip_recommendations_queue::{QueueConfig, QueueProducer},
    stream_session_lifecycle::*,
};
use futures_util::{FutureExt, TryStreamExt};
use serde_json::{Value, json};
use std::{
    panic::AssertUnwindSafe,
    sync::{
        Arc,
        atomic::{AtomicU8, AtomicUsize, Ordering},
    },
    time::Duration,
};
const NOW: i64 = 1794355200000;
const INFOS: [&CollectionInfo; 4] = [
    &dima_model::stream_sessions::INFO,
    &dima_model::cron_job_intents::INFO,
    &dima_model::cliprecommendationconfigs::INFO,
    &dima_model::users::INFO,
];
#[derive(Debug, Default)]
struct Counting(AtomicU8);
impl Random for Counting {
    fn fill(&self, b: &mut [u8]) -> Result<(), RandomError> {
        b.fill(self.0.fetch_add(1, Ordering::SeqCst) + 1);
        Ok(())
    }
}
struct Prefixed {
    inner: DragonflyQueue,
    prefix: String,
}
impl JobQueue for Prefixed {
    async fn publish(
        &self,
        key: &str,
        automatic: Option<&str>,
        payload: &QueueItem,
    ) -> Result<bool, StoreError> {
        self.inner
            .publish(
                &format!("{}{key}", self.prefix),
                automatic.map(|s| format!("{}{s}", self.prefix)).as_deref(),
                payload,
            )
            .await
    }
    async fn marker_exists(&self, key: &str) -> Result<bool, StoreError> {
        self.inner
            .marker_exists(&format!("{}{key}", self.prefix))
            .await
    }
}
fn recording() -> Result<Value> {
    Ok(serde_json::from_str(include_str!(
        "stream-lifecycle-reference.json"
    ))?)
}
fn document(v: &Value) -> Result<Document> {
    Ok(Bson::try_from(v.clone())?
        .as_document()
        .context("document")?
        .clone())
}
async fn seed(store: &MongoStore, seed: &Value) -> Result<()> {
    for info in INFOS {
        store.documents(info.name).delete_many(doc! {}).await?;
        for row in seed[info.name].as_array().context("seed")? {
            store
                .documents(info.name)
                .insert_one(document(row)?)
                .await?;
        }
    }
    Ok(())
}
async fn jobs(
    store: &MongoStore,
    cache: &Dragonfly,
    random: Arc<Counting>,
) -> Result<DurableJobs<Prefixed>> {
    for info in INFOS {
        for index in info.indexes {
            store
                .documents(info.name)
                .create_index(index.model())
                .await?;
        }
    }
    let info = &dima_model::cron_job_intents::INFO;
    let report = dima_model::ensure_indexes(
        store,
        info,
        dima_model::startup_policy(info).context("policy")?,
        Duration::from_secs(30),
    )
    .await;
    Ok(DurableJobs::new(
        store.clone(),
        Prefixed {
            inner: DragonflyQueue {
                dragonfly: cache.clone(),
                deadline: Duration::from_secs(5),
            },
            prefix: format!("{}:", store.database().name()),
        },
        Arc::new(ManualClock::new(NOW)),
        random,
        JobsConfig::default(),
        &report,
    )?)
}
fn producer<'a>(
    jobs: &'a DurableJobs<Prefixed>,
    random: &'a Counting,
    clock: &'a ManualClock,
) -> QueueProducer<'a, Prefixed> {
    QueueProducer {
        jobs,
        random,
        clock,
        config: QueueConfig::default(),
    }
}
async fn apply(
    l: &StreamSessionLifecycle,
    p: &QueueProducer<'_, Prefixed>,
    kind: &str,
    input: &Value,
) -> Result<Value> {
    let result = if kind == "online" {
        l.record_stream_online_event(&serde_json::from_value(input.clone())?, p)
            .await
    } else {
        l.record_stream_offline_event(&serde_json::from_value(input.clone())?, p)
            .await
    };
    Ok(match result {
        Ok(()) => Value::Null,
        Err(LifecycleError::MissingPrerequisite(s)) => json!({"prerequisite":s}),
        Err(e) => json!({"error":e.to_string()}),
    })
}
fn normalize(v: &mut Bson, maps: &[(String, String)]) {
    match v {
        Bson::ObjectId(id) => {
            let s = id.to_hex();
            if let Some((_, new)) = maps.iter().find(|(old, _)| old == &s) {
                *id = ObjectId::parse_str(new).unwrap();
            }
        }
        Bson::String(s) => {
            for (old, new) in maps {
                *s = s.replace(old, new)
            }
        }
        Bson::Document(d) => {
            for (_, v) in d.iter_mut() {
                normalize(v, maps)
            }
        }
        Bson::Array(a) => {
            for v in a {
                normalize(v, maps)
            }
        }
        _ => {}
    }
}
async fn snapshot(store: &MongoStore, cache: &Dragonfly) -> Result<Value> {
    let sessions: Vec<Document> = store
        .documents("streamsessions")
        .find(doc! {})
        .await?
        .try_collect()
        .await?;
    let maps: Vec<(String, String)> = sessions
        .iter()
        .map(|d| {
            let old = d.get_object_id("_id")?.to_hex();
            let new = if old.starts_with("012345") {
                old.clone()
            } else {
                dima_core::crypto::sha256(format!(
                    "{}:{}",
                    d.get_str("channelID")?,
                    d.get_str("stream_id")?
                ))
                .hex()
                .get(..24)
                .context("hash")?
                .to_owned()
            };
            Ok((old, new))
        })
        .collect::<Result<_>>()?;
    let mut documents = serde_json::Map::new();
    for info in INFOS {
        let rows: Vec<Document> = store
            .documents(info.name)
            .find(doc! {})
            .await?
            .try_collect()
            .await?;
        let mut values = Vec::new();
        for mut row in rows {
            (info.decode)(&bson::RawDocumentBuf::try_from(&row)?)?;
            if info.name == "cron_job_intents" {
                row.insert("_id", ObjectId::from_bytes([0; 12]));
            }
            let mut value = Bson::Document(row);
            normalize(&mut value, &maps);
            values.push(value.into_canonical_extjson());
        }
        values.sort_by_key(|v| v["_id"].to_string());
        documents.insert(info.name.into(), json!(values));
    }
    let prefix = format!("{}:", store.database().name());
    let mut scan = cache.scan(&format!("{prefix}*"), Some(100));
    let mut keys = Vec::new();
    while let Some(page) = scan.next_page().await? {
        keys.extend(page);
    }
    keys.sort();
    let mut state = Vec::new();
    for key in keys {
        let key = String::from_utf8(key)?;
        let kind: String = cache.query(redis::cmd("TYPE").arg(&key)).await?;
        let ttl: i64 = cache.query(redis::cmd("TTL").arg(&key)).await?;
        let value = if kind == "list" {
            let rows: Vec<String> = cache
                .query(redis::cmd("LRANGE").arg(&key).arg(0).arg(-1))
                .await?;
            json!(
                rows.into_iter()
                    .map(|s| serde_json::from_str::<Value>(&s))
                    .collect::<Result<Vec<_>, _>>()?
            )
        } else {
            json!(cache.query::<String>(redis::cmd("GET").arg(&key)).await?)
        };
        state.push(json!({"key":key.strip_prefix(&prefix).context("prefix")?,"type":kind,"ttl":ttl,"value":value}));
    }
    Ok(json!({"documents":documents,"cache":state}))
}
async fn with_stores<F, Fut>(test: F) -> Result<()>
where
    F: FnOnce(MongoStore, Dragonfly) -> Fut,
    Fut: std::future::Future<Output = Result<()>>,
{
    support::with_store(|store| async move {
        let Some(cache) = support::cache().await? else {
            return Ok(());
        };
        let prefix = format!("{}:", store.database().name());
        let result = AssertUnwindSafe(test(store, cache.clone()))
            .catch_unwind()
            .await;
        support::cleanup(&cache, &prefix).await?;
        match result {
            Ok(r) => r,
            Err(p) => std::panic::resume_unwind(p),
        }
    })
    .await
}
#[tokio::test]
async fn recorded_lifecycle_bson_jobs_cache_and_retry_paths() -> Result<()> {
    with_stores(|store, cache| async move {
        let random = Arc::new(Counting::default());
        let jobs = jobs(&store, &cache, random.clone()).await?;
        let clock = ManualClock::new(NOW);
        let p = producer(&jobs, &random, &clock);
        for case in recording()?["cases"].as_array().context("cases")? {
            seed(&store, &case["seed"]).await?;
            for step in case["steps"].as_array().context("steps")? {
                random.0.store(
                    u8::try_from(step["randomBefore"].as_u64().context("random")?)?,
                    Ordering::SeqCst,
                );
                let counts = Arc::new(std::sync::Mutex::new(std::collections::BTreeMap::<
                    String,
                    u32,
                >::new()));
                let observed = counts.clone();
                let fault = case["name"]
                    .as_str()
                    .context("case name")?
                    .strip_prefix("retry-")
                    .or_else(|| case["name"].as_str()?.strip_prefix("keyed-no-retry-"))
                    .map(str::to_owned);
                let l = StreamSessionLifecycle::new(store.clone(), Arc::new(ManualClock::new(NOW)))
                    .with_operation_hook(Arc::new(move |op| {
                        let mut counts = observed.lock().unwrap();
                        let count = counts.entry(op.into()).or_default();
                        *count += 1;
                        if fault.as_deref() == Some(op) && *count == 1 {
                            return Err(dima_stream::Error::Invalid(
                                "injected write conflict".into(),
                            ));
                        }
                        Ok(())
                    }));
                let result = apply(
                    &l,
                    &p,
                    step["kind"].as_str().context("kind")?,
                    &step["input"],
                )
                .await?;
                ensure!(
                    result == step["result"],
                    "{} result {result} != {}",
                    case["name"],
                    step["result"]
                );
                let expected = step["attempts"].as_object().context("attempts")?;
                for (op, n) in expected {
                    ensure!(
                        counts.lock().unwrap().get(op).copied() == n.as_u64().map(|v| v as u32),
                        "{} retry count {op}",
                        case["name"]
                    );
                }
                let actual = snapshot(&store, &cache).await?;
                ensure!(
                    actual["documents"] == step["documents"],
                    "{} BSON mismatch: {actual} != {}",
                    case["name"],
                    step["documents"]
                );
                ensure!(
                    actual["cache"] == step["cache"],
                    "{} cache mismatch",
                    case["name"]
                );
            }
        }
        Ok(())
    })
    .await
}
#[tokio::test]
async fn recorded_cancellation_after_every_lifecycle_and_job_write() -> Result<()> {
    with_stores(|store, cache| async move {
        let random = Arc::new(Counting::default());
        let jobs = Arc::new(jobs(&store, &cache, random.clone()).await?);
        let clock = ManualClock::new(NOW);
        for fault in recording()?["faults"].as_array().context("faults")? {
            seed(&store, &fault["seed"]).await?;
            random.0.store(0, Ordering::SeqCst);
            let cut = fault["cut"].as_u64().context("cut")? as usize;
            let signal = Arc::new(tokio::sync::Notify::new());
            let notify = signal.clone();
            let count = Arc::new(AtomicUsize::new(0));
            let l = StreamSessionLifecycle::new(store.clone(), Arc::new(ManualClock::new(NOW)))
                .with_write_hook(Arc::new(move || {
                    let hit = count.fetch_add(1, Ordering::SeqCst) + 1 == cut;
                    let notify = notify.clone();
                    Box::pin(async move {
                        if hit {
                            notify.notify_one();
                            std::future::pending::<()>().await;
                        }
                    })
                }));
            let child_jobs = jobs.clone();
            let child_random = random.clone();
            let op = fault["op"].clone();
            let child = tokio::spawn(async move {
                let clock = ManualClock::new(NOW);
                apply(
                    &l,
                    &producer(&child_jobs, &child_random, &clock),
                    op["kind"].as_str().unwrap(),
                    &op["input"],
                )
                .await
            });
            let observed = tokio::time::timeout(Duration::from_secs(60), signal.notified()).await;
            child.abort();
            let joined = child.await;
            observed?;
            ensure!(joined.is_err_and(|e| e.is_cancelled()));
            ensure!(
                snapshot(&store, &cache).await? == fault["partial"],
                "{} partial write {cut}",
                fault["name"]
            );
            random.0.store(
                u8::try_from(fault["randomBefore"].as_u64().context("random")?)?,
                Ordering::SeqCst,
            );
            let l = StreamSessionLifecycle::new(store.clone(), Arc::new(ManualClock::new(NOW)));
            let op = &fault["op"];
            ensure!(
                apply(
                    &l,
                    &producer(&jobs, &random, &clock),
                    op["kind"].as_str().context("kind")?,
                    &op["input"]
                )
                .await?
                    == fault["result"]
            );
            let actual = snapshot(&store, &cache).await?;
            ensure!(
                actual["documents"] == fault["documents"],
                "{} replay write {cut}: {actual} != {}",
                fault["name"],
                fault["documents"]
            );
            ensure!(actual["cache"] == fault["cache"]);
        }
        Ok(())
    })
    .await
}
fn sort_receipts(v: &mut Value) {
    match v {
        Value::Object(d) => {
            for (k, v) in d {
                if k == "applied_domain_event_keys" {
                    if let Some(a) = v.as_array_mut() {
                        a.sort_by_key(Value::to_string);
                    }
                } else {
                    sort_receipts(v)
                }
            }
        }
        Value::Array(a) => {
            for v in a {
                sort_receipts(v)
            }
        }
        _ => {}
    }
}
#[tokio::test]
async fn two_process_lifecycle_races_settle_like_reference() -> Result<()> {
    with_stores(|store, cache| async move {
        let random = Arc::new(Counting::default());
        let jobs = jobs(&store, &cache, random.clone()).await?;
        let clock = ManualClock::new(NOW);
        let p = producer(&jobs, &random, &clock);
        for case in recording()?["races"].as_array().context("races")? {
            seed(&store, &case["seed"]).await?;
            store
                .documents("lifecycle_test_barrier")
                .delete_many(doc! {})
                .await?;
            store
                .documents("lifecycle_test_results")
                .delete_many(doc! {})
                .await?;
            let mut children = Vec::new();
            for op in case["ops"].as_array().context("ops")? {
                children.push(
                    tokio::process::Command::new(std::env::current_exe()?)
                        .args(["--exact", "lifecycle_process_child", "--nocapture"])
                        .env("DIMA_LIFECYCLE_CHILD_DB", store.database().name())
                        .env("DIMA_LIFECYCLE_CHILD_OP", serde_json::to_string(op)?)
                        .kill_on_drop(true)
                        .spawn()?,
                );
            }
            let barrier = store.documents("lifecycle_test_barrier");
            // A readiness barrier bounds process startup under other concurrent builds.
            tokio::time::timeout(Duration::from_secs(60), async {
                loop {
                    if barrier.count_documents(doc! {"ready":true}).await? == 2 {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                Ok::<(), mongodb::error::Error>(())
            })
            .await??;
            barrier.insert_one(doc! {"_id":"release"}).await?;
            for mut child in children {
                ensure!(
                    tokio::time::timeout(Duration::from_secs(60), child.wait())
                        .await??
                        .success()
                );
            }
            let l = StreamSessionLifecycle::new(store.clone(), Arc::new(ManualClock::new(NOW)));
            for step in case["redeliveries"].as_array().context("redeliveries")? {
                random.0.store(
                    u8::try_from(step["randomBefore"].as_u64().context("random")?)?,
                    Ordering::SeqCst,
                );
                let result = apply(
                    &l,
                    &p,
                    step["op"]["kind"].as_str().context("kind")?,
                    &step["op"]["input"],
                )
                .await?;
                if case["name"] == "new-online-stale-offline" {
                    ensure!(
                        result.is_null()
                            || result["prerequisite"]
                                .as_str()
                                .is_some_and(|s| s.starts_with("stream-session:channel:")),
                        "unexpected redelivery {result}"
                    );
                } else {
                    ensure!(result == step["result"]);
                }
            }
            let mut actual = snapshot(&store, &cache).await?;
            let mut expected = json!({"documents":case["documents"],"cache":case["cache"]});
            // addToSet receipt order follows the winner; set membership is authoritative.
            sort_receipts(&mut actual);
            sort_receipts(&mut expected);
            if case["name"] == "new-online-stale-offline" || case["name"] == "online-offline" {
                let prefix = if case["name"] == "online-offline" {
                    "same-stream-race-"
                } else {
                    "new-stream-race-"
                };
                let r = recording()?;
                let variants = r["cases"]
                    .as_array()
                    .context("cases")?
                    .iter()
                    .filter(|c| {
                        c["name"]
                            .as_str()
                            .is_some_and(|name| name.starts_with(prefix))
                    })
                    .map(|c| {
                        let last = c["steps"].as_array().unwrap().last().unwrap();
                        let mut v = json!({"documents":last["documents"],"cache":last["cache"]});
                        sort_receipts(&mut v);
                        v
                    })
                    .collect::<Vec<_>>();
                ensure!(
                    variants.contains(&actual),
                    "stale offline race {actual} != reference variants {variants:?}"
                );
            } else {
                ensure!(
                    actual == expected,
                    "race {}: {actual} != {expected}",
                    case["name"]
                );
            }
            let sessions: Vec<Document> = store
                .documents("streamsessions")
                .find(doc! {})
                .await?
                .try_collect()
                .await?;
            ensure!(
                sessions.len()
                    == if case["name"] == "new-online-stale-offline" {
                        2
                    } else {
                        1
                    },
                "duplicate session"
            );
            let results: Vec<Document> = store
                .documents("lifecycle_test_results")
                .find(doc! {})
                .await?
                .try_collect()
                .await?;
            ensure!(results.len() == 2);
        }
        Ok(())
    })
    .await
}
#[tokio::test]
async fn lifecycle_process_child() -> Result<()> {
    let Ok(database) = std::env::var("DIMA_LIFECYCLE_CHILD_DB") else {
        return Ok(());
    };
    ensure!(database.starts_with("dima_test_stream_"));
    let store = support::mongo(&database).await?.context("store")?;
    let cache = support::cache().await?.context("cache")?;
    let random = Arc::new(Counting::default());
    let jobs = jobs(&store, &cache, random.clone()).await?;
    let clock = ManualClock::new(NOW);
    let barrier = store.documents("lifecycle_test_barrier");
    barrier
        .insert_one(doc! {"_id":i64::from(std::process::id()),"ready":true})
        .await?;
    tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            if barrier.find_one(doc! {"_id":"release"}).await?.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        Ok::<(), mongodb::error::Error>(())
    })
    .await??;
    let op: Value = serde_json::from_str(&std::env::var("DIMA_LIFECYCLE_CHILD_OP")?)?;
    let l = StreamSessionLifecycle::new(store.clone(), Arc::new(ManualClock::new(NOW)));
    let result = apply(
        &l,
        &producer(&jobs, &random, &clock),
        op["kind"].as_str().context("kind")?,
        &op["input"],
    )
    .await?;
    store
        .documents("lifecycle_test_results")
        .insert_one(doc! {"result":bson::serialize_to_bson(&result).context("result")?})
        .await?;
    Ok(())
}
#[tokio::test]
async fn real_lifecycle_read_types() -> Result<()> {
    let Some(store) = support::mongo("domdimabot").await? else {
        return Ok(());
    };
    for info in [
        &dima_model::stream_sessions::INFO,
        &dima_model::users::INFO,
        &dima_model::cliprecommendationconfigs::INFO,
    ] {
        let rows: Vec<bson::RawDocumentBuf> = store
            .documents(info.name)
            .clone_with_type()
            .find(doc! {})
            .limit(100)
            .await?
            .try_collect()
            .await?;
        ensure!(!rows.is_empty(), "{} empty real sample", info.name);
        for row in &rows {
            (info.decode)(row)?;
        }
        eprintln!(
            "{}: {} real records decoded read-only",
            info.name,
            rows.len()
        );
    }
    Ok(())
}
