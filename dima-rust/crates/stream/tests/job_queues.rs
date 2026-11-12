mod support;
use anyhow::{Context, Result, ensure};
use bson::{Bson, doc};
use dima_core::{ManualClock, Random, RandomError};
use dima_events::jobs::{DragonflyQueue, DurableJobs, JobQueue, JobsConfig};
use dima_events::store::StoreError;
use dima_model::cron_job_intents::INFO;
use dima_store::dragonfly::{Dragonfly, DragonflyConfig, Hooks, QueueItem};
use dima_stream::clip_recommendations_queue::*;
use dima_stream::stream_memory_queue::*;
use futures_util::{FutureExt, TryStreamExt};
use serde_json::{Value, json};
use std::{
    panic::AssertUnwindSafe,
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
    time::Duration,
};

#[derive(Debug, Default)]
struct Counting(AtomicU8);
impl Random for Counting {
    fn fill(&self, buf: &mut [u8]) -> Result<(), RandomError> {
        buf.fill(self.0.fetch_add(1, Ordering::SeqCst) + 1);
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
fn fixture() -> Result<Value> {
    Ok(serde_json::from_str(include_str!(
        "job-queues-reference.json"
    ))?)
}
#[test]
fn recorded_identities_and_periods() -> Result<()> {
    let fixture = fixture()?;
    for case in fixture["dedupe"].as_array().context("dedupe")? {
        let channel = case["channel"].as_str().context("channel")?;
        let session = case["session"].as_str();
        let last = case["last"].as_str();
        ensure!(get_clip_recommendation_dedupe_key(channel, session, last) == case["clip"]);
        ensure!(get_stream_memory_summary_dedupe_key(channel, session, last) == case["summary"]);
        ensure!(
            get_maintenance_dedupe_key(channel, Cadence::Weekly, last.unwrap_or_default())
                == case["weekly"]
        );
        ensure!(
            get_maintenance_dedupe_key(channel, Cadence::Monthly, last.unwrap_or_default())
                == case["monthly"]
        );
    }
    for case in fixture["periods"].as_array().context("periods")? {
        let now = case["now"].as_i64().context("now")?;
        ensure!(get_weekly_maintenance_period_token(now)? == case["weekly"]);
        ensure!(get_monthly_maintenance_period_token(now)? == case["monthly"]);
    }
    Ok(())
}
async fn cache() -> Result<Option<Dragonfly>> {
    let address = match std::env::var("DIMA_TEST_DRAGONFLY") {
        Ok(s) => s,
        Err(e) if std::env::var("DIMA_TEST_REQUIRE_STORES").as_deref() == Ok("1") => {
            return Err(e.into());
        }
        Err(_) => {
            eprintln!("skipped: scratch Dragonfly unavailable");
            return Ok(None);
        }
    };
    let (host, port) = address.rsplit_once(':').context("host:port")?;
    Ok(Some(
        Dragonfly::connect(
            DragonflyConfig::from_env_values(
                Some(host),
                Some(&format!("{port}/7")),
                "stream-job-tests",
            ),
            Hooks::default(),
        )
        .await?,
    ))
}
async fn state(cache: &Dragonfly, prefix: &str) -> Result<Value> {
    let mut keys = Vec::new();
    let mut scan = cache.scan(&format!("{prefix}*"), Some(100));
    while let Some(page) = scan.next_page().await? {
        keys.extend(page);
    }
    keys.sort();
    let mut values = Vec::new();
    for key in keys {
        let key = String::from_utf8(key)?;
        let kind: String = cache.query(redis::cmd("TYPE").arg(&key)).await?;
        let ttl: i64 = cache.query(redis::cmd("TTL").arg(&key)).await?;
        let value = if kind == "list" {
            let list: Vec<String> = cache
                .query(redis::cmd("LRANGE").arg(&key).arg(0).arg(-1))
                .await?;
            json!(list)
        } else {
            json!(cache.query::<String>(redis::cmd("GET").arg(&key)).await?)
        };
        values.push(json!({"key":key.strip_prefix(prefix).context("prefix")?,"type":kind,"ttl":ttl,"value":value}));
    }
    Ok(json!(values))
}
#[tokio::test]
async fn recorded_payload_bytes_returns_cache_ttls_and_typed_mongo() -> Result<()> {
    support::with_store(|store| async move {
        let Some(cache) = cache().await? else {
            return Ok(());
        };
        let prefix = format!("dima_test_stream_{}:", uuid::Uuid::new_v4());
        let outcome = AssertUnwindSafe(async {
            let report = dima_model::ensure_indexes(
                &store,
                &INFO,
                dima_model::startup_policy(&INFO).context("policy")?,
                Duration::from_secs(30),
            )
            .await;
            let clock = Arc::new(ManualClock::new(0));
            let random = Arc::new(Counting::default());
            let jobs = DurableJobs::new(
                store.clone(),
                Prefixed {
                    inner: DragonflyQueue {
                        dragonfly: cache.clone(),
                        deadline: Duration::from_secs(5),
                    },
                    prefix: prefix.clone(),
                },
                clock.clone(),
                random.clone(),
                JobsConfig::default(),
                &report,
            )?;
            let producer = QueueProducer {
                jobs: &jobs,
                clock: clock.as_ref(),
                random: random.as_ref(),
                config: QueueConfig::default(),
            };
            for (index, step) in fixture()?["steps"]
                .as_array()
                .context("steps")?
                .iter()
                .enumerate()
            {
                clock.set(step["now"].as_i64().context("now")?);
                random.0.store(u8::try_from(index)?, Ordering::SeqCst);
                let input = step["input"].clone();
                let result = match step["kind"].as_str() {
                    Some("clip") => {
                        enqueue_clip_recommendation_job(&producer, &serde_json::from_value(input)?)
                            .await?
                    }
                    Some("summary") => {
                        enqueue_stream_memory_summary_job(
                            &producer,
                            &serde_json::from_value(input)?,
                        )
                        .await?
                    }
                    _ => {
                        enqueue_memory_maintenance_job(&producer, &serde_json::from_value(input)?)
                            .await?
                    }
                };
                ensure!(
                    dima_text::to_js_json(&serde_json::to_value(&result)?)
                        == dima_text::to_js_json(&step["result"]),
                    "return step {index}: {:?} != {}",
                    result,
                    step["result"]
                );
                ensure!(
                    state(&cache, &prefix).await? == step["state"],
                    "cache/bytes/TTL step {index}: {} != {}",
                    state(&cache, &prefix).await?,
                    step["state"]
                );
                let documents = store
                    .documents(INFO.name)
                    .find(doc! {})
                    .sort(doc! {"jobID":1})
                    .await?
                    .try_collect::<Vec<_>>()
                    .await?;
                let documents: Vec<Value> = documents
                    .into_iter()
                    .map(|doc| {
                        ensure!(
                            matches!(doc.get("_id"), Some(Bson::ObjectId(_))),
                            "BSON ObjectId"
                        );
                        let job_id = doc.get_str("jobID")?;
                        let mapped = format!("generated:{job_id}");
                        let mut json = Bson::Document(doc).into_canonical_extjson();
                        json["_id"] = json!({"$oid":mapped});
                        Ok(json)
                    })
                    .collect::<Result<_>>()?;
                ensure!(
                    json!(documents) == step["documents"],
                    "BSON step {index}: {} != {}",
                    json!(documents),
                    step["documents"]
                );
            }
            let input = StreamMemorySummaryInput {
                channel_id: "race".into(),
                session_id: Some("one".into()),
                ..Default::default()
            };
            let results = futures_util::future::try_join_all(
                (0..8).map(|_| enqueue_stream_memory_summary_job(&producer, &input)),
            )
            .await?;
            let accepted = results.iter().filter(|r| r.enqueued).count();
            let ids: std::collections::HashSet<_> = results
                .iter()
                .filter_map(|r| r.job.as_ref().map(|j| &j.id))
                .collect();
            let intents = store
                .documents(INFO.name)
                .count_documents(doc! {"payload.channelID":"race"})
                .await?;
            ensure!(
                json!({"accepted":accepted,"canonical":ids.len(),"intents":intents})
                    == fixture()?["race"],
                "concurrent acceptance"
            );
            Ok(())
        })
        .catch_unwind()
        .await;
        support::cleanup(&cache, &prefix).await?;
        ensure!(
            state(&cache, &prefix).await? == json!([]),
            "scratch keys remain"
        );
        match outcome {
            Ok(result) => result,
            Err(p) => std::panic::resume_unwind(p),
        }
    })
    .await
}
