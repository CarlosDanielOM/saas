mod support;
use anyhow::{Context, Result};
use bson::{Bson, Document, doc, oid::ObjectId};
use dima_core::ManualClock;
use dima_events::consumer::handler::Outcome;
use dima_model::CollectionInfo;
use dima_store::mongo::{MongoStore, WriteContext};
use dima_stream::{stream_session_event_projection::*, stream_timeline::*};
use futures_util::TryStreamExt;
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Arc};
fn fixture() -> Result<Value> {
    Ok(serde_json::from_str(include_str!(
        "timeline-reference.json"
    ))?)
}
fn doc_value(v: &Value) -> Result<Document> {
    Ok(Bson::try_from(v.clone())?
        .as_document()
        .context("document")?
        .clone())
}
fn normalized(v: &Value) -> Result<Value> {
    Ok(serde_json::from_str(&dima_text::to_js_json(v))?)
}
const COLLECTIONS: [&CollectionInfo; 6] = [
    &dima_model::stream_sessions::INFO,
    &dima_model::stream_viewer_snapshots::INFO,
    &dima_model::domain_events::INFO,
    &dima_model::stream_participants::INFO,
    &dima_model::stream_markers::INFO,
    &dima_model::stream_activities::INFO,
];
async fn seed(store: &MongoStore, r: &Value) -> Result<()> {
    for info in COLLECTIONS {
        for row in r["seed"][info.name].as_array().context("seed")? {
            let p = info.prepare_create(
                &doc_value(row)?,
                &mut WriteContext::new(r["now"].as_i64().context("now")?),
            )?;
            store.writes(info.name).insert_one(&p).await?;
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
async fn apply(t: &Timeline, m: &SessionMetrics, op: &Value) -> Result<Value> {
    let d = doc_value(op)?;
    if let Ok(v) = d.get_document("participant") {
        t.record_timeline_participant(&bson::deserialize_from_document(v.clone())?)
            .await?;
    }
    if let Ok(v) = d.get_document("redemption") {
        t.record_timeline_redemption(&bson::deserialize_from_document(v.clone())?)
            .await?;
    }
    if let Ok(v) = d.get_document("moment") {
        t.record_timeline_moment(&bson::deserialize_from_document(v.clone())?)
            .await?;
    }
    if let Ok(v) = d.get_document("metric") {
        return Ok(
            match m
                .increment_session_metric_at_event_time(&bson::deserialize_from_document(
                    v.clone(),
                )?)
                .await
            {
                Ok(v) => serde_json::to_value(v)?,
                Err(Outcome::MissingPrerequisite(p)) => json!({"prerequisite":p}),
                Err(e) => anyhow::bail!("metric failure {e:?}"),
            },
        );
    }
    Ok(Value::Null)
}
fn objects(store: MongoStore, now: i64) -> Result<(Timeline, SessionMetrics)> {
    let clock = Arc::new(ManualClock::new(now));
    Ok((
        Timeline::new(store.clone(), clock.clone())?,
        SessionMetrics::new(store, clock),
    ))
}
async fn snapshot(store: &MongoStore) -> Result<(Value, HashMap<String, String>)> {
    let mut out = serde_json::Map::new();
    let mut ids = HashMap::new();
    for info in COLLECTIONS {
        let rows: Vec<Document> = store
            .documents(info.name)
            .find(doc! {})
            .await?
            .try_collect()
            .await?;
        let mut mapped = Vec::new();
        for mut d in rows {
            if ["stream_markers", "stream_participants"].contains(&info.name) {
                let key = if info.name == "stream_markers" {
                    d.get_str("key")?.to_owned()
                } else {
                    format!(
                        "{}:{}",
                        d.get_str("user_id")?,
                        dima_store::mongo::number::read_number(d.get("bucket").context("bucket")?)
                            .context("number")?
                    )
                };
                let hash = dima_core::crypto::sha256(format!("{}:{key}", info.name)).hex();
                let id = hash.get(..24).context("hash")?.to_owned();
                ids.insert(d.get_object_id("_id")?.to_hex(), id.clone());
                d.insert("_id", ObjectId::parse_str(id)?);
            }
            let raw = bson::RawDocumentBuf::try_from(&d)?;
            (info.decode)(&raw)?;
            mapped.push(Bson::Document(d).into_canonical_extjson());
        }
        mapped.sort_by_key(|v| v["_id"].to_string());
        out.insert(info.name.into(), Value::Array(mapped));
    }
    Ok((Value::Object(out), ids))
}
fn replace(v: &mut Value, ids: &HashMap<String, String>) {
    match v {
        Value::String(s) => {
            if let Some(id) = ids.get(s) {
                *s = id.clone();
            }
        }
        Value::Array(a) => {
            for v in a {
                replace(v, ids)
            }
        }
        Value::Object(o) => {
            for v in o.values_mut() {
                replace(v, ids)
            }
        }
        _ => {}
    }
}
fn redact(v: &mut Value) {
    match v {
        Value::String(s) => *s = dima_core::crypto::sha256(s.as_bytes()).hex(),
        Value::Array(a) => {
            for v in a {
                redact(v)
            }
        }
        Value::Object(o) => {
            for v in o.values_mut() {
                redact(v)
            }
        }
        _ => {}
    }
}
async fn reads(t: &Timeline, channel: &str, id: &str, pages: &str) -> Result<Value> {
    let mut tiers = serde_json::Map::new();
    for tier in ["free", "premium", "pro"] {
        tiers.insert(tier.into(), t.get_stream_timeline(channel, id, tier).await?);
    }
    Ok(
        json!({"session":t.get_timeline_session(channel,ObjectId::parse_str(id)?).await?.map(|d|dima_store::mongo::json::to_json_value(&d)),"pages":[t.list_timeline_streams(pages,1).await?,t.list_timeline_streams(pages,2).await?],"tiers":tiers}),
    )
}
#[tokio::test]
async fn recorded_timeline_documents_receipts_and_reads() -> Result<()> {
    support::with_store(|store| async move {
        let r = fixture()?;
        let now = r["now"].as_i64().context("now")?;
        seed(&store, &r).await?;
        let (t, m) = objects(store.clone(), now)?;
        let mut compared = 0;
        for step in r["steps"].as_array().context("steps")? {
            assert_eq!(
                apply(&t, &m, &step["op"]).await?,
                step["result"],
                "{} result",
                step["name"]
            );
            let (documents, ids) = snapshot(&store).await?;
            assert_eq!(documents, step["documents"], "{} documents", step["name"]);
            compared += documents
                .as_object()
                .context("docs")?
                .values()
                .filter_map(Value::as_array)
                .map(Vec::len)
                .sum::<usize>();
            let mut actual = reads(
                &t,
                "channel",
                &r["id"].as_str().context("id")?.to_uppercase(),
                "pages",
            )
            .await?;
            replace(&mut actual, &ids);
            assert_eq!(
                normalized(&actual)?,
                normalized(&step["reads"])?,
                "{} reads",
                step["name"]
            );
        }
        eprintln!(
            "timeline: {} steps, {compared} exact BSON documents, {} read groups",
            r["steps"].as_array().context("steps")?.len(),
            r["steps"].as_array().context("steps")?.len() * 6
        );
        Ok(())
    })
    .await
}
#[tokio::test]
async fn real_sessions_match_typescript() -> Result<()> {
    let Some(store) = support::mongo("domdimabot").await? else {
        return Ok(());
    };
    let r: Value = serde_json::from_str(include_str!("timeline-real-reference.json"))?;
    let (t, _) = objects(store, r["now"].as_i64().context("now")?)?;
    for case in r["cases"].as_array().context("cases")? {
        let channel = case["channel"].as_str().context("channel")?;
        let mut actual = reads(&t, channel, case["id"].as_str().context("id")?, channel).await?;
        redact(&mut actual);
        assert_eq!(normalized(&actual)?, normalized(&case["reads"])?);
    }
    eprintln!("12 real timeline sessions / 72 reads matched");
    Ok(())
}
#[tokio::test]
async fn cancellation_after_every_write_and_two_processes() -> Result<()> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let r = fixture()?;
    let steps = r["steps"].as_array().context("steps")?;
    let now = r["now"].as_i64().context("now")?;
    let mut boundaries = 0;
    for name in ["participant", "redemption", "moment", "metric"] {
        let index = steps
            .iter()
            .position(|s| s["name"] == name)
            .context("index")?;
        for cut in 1..=if name == "metric" { 1 } else { 2 } {
            boundaries += 1;
            let r = r.clone();
            support::with_store(|store| async move {
                seed(&store, &r).await?;
                let (t, m) = objects(store.clone(), now)?;
                let steps = r["steps"].as_array().context("steps")?;
                for step in steps.iter().take(index) {
                    apply(&t, &m, &step["op"]).await?;
                }
                let stop = Arc::new(tokio::sync::Notify::new());
                let signal = stop.clone();
                let n = Arc::new(AtomicUsize::new(0));
                let hook: Arc<
                    dyn Fn() -> futures_util::future::BoxFuture<'static, ()> + Send + Sync,
                > = Arc::new(move || {
                    let hit = n.fetch_add(1, Ordering::SeqCst) + 1 == cut;
                    let signal = signal.clone();
                    Box::pin(async move {
                        if hit {
                            signal.notify_one();
                            std::future::pending::<()>().await;
                        }
                    })
                });
                let (ft, fm) = objects(store.clone(), now)?;
                let ft = ft.with_write_hook(hook.clone());
                let fm = fm.with_write_hook(hook);
                let op = steps[index]["op"].clone();
                let child = tokio::spawn(async move { apply(&ft, &fm, &op).await });
                tokio::time::timeout(std::time::Duration::from_secs(20), stop.notified()).await?;
                child.abort();
                assert!(child.await.is_err_and(|e| e.is_cancelled()));
                apply(&t, &m, &steps[index]["op"]).await?;
                assert_eq!(snapshot(&store).await?.0, steps[index]["documents"]);
                Ok(())
            })
            .await?;
        }
    }
    // One independent process per duplicate delivery, racing the session receipt guard.
    support::with_store(|store| {
        let r = r.clone();
        async move {
            seed(&store, &r).await?;
            let steps = r["steps"].as_array().context("steps")?;
            let index = steps
                .iter()
                .position(|s| s["name"] == "metric")
                .context("metric")?;
            let (t, m) = objects(store.clone(), now)?;
            for step in steps.iter().take(index) {
                apply(&t, &m, &step["op"]).await?;
            }
            let mut children = Vec::new();
            for _ in 0..2 {
                children.push(
                    tokio::process::Command::new(std::env::current_exe()?)
                        .args(["--exact", "metric_child", "--nocapture"])
                        .env("DIMA_TIMELINE_CHILD", store.database().name())
                        .spawn()?,
                );
            }
            for mut child in children {
                assert!(child.wait().await?.success());
            }
            assert_eq!(snapshot(&store).await?.0, steps[index]["documents"]);
            Ok(())
        }
    })
    .await?;
    eprintln!(
        "timeline: recovered after all {boundaries} writes; two OS processes applied metric once"
    );
    Ok(())
}
#[tokio::test]
async fn metric_child() -> Result<()> {
    let Ok(db) = std::env::var("DIMA_TIMELINE_CHILD") else {
        return Ok(());
    };
    assert!(db.starts_with("dima_test_stream_"));
    let store = support::mongo(&db).await?.context("store")?;
    let r = fixture()?;
    let (t, m) = objects(store, r["now"].as_i64().context("now")?)?;
    let step = r["steps"]
        .as_array()
        .context("steps")?
        .iter()
        .find(|s| s["name"] == "metric")
        .context("metric")?;
    apply(&t, &m, &step["op"]).await?;
    Ok(())
}
#[tokio::test]
async fn all_real_timeline_collections_decode() -> Result<()> {
    let Some(store) = support::mongo("domdimabot").await? else {
        return Ok(());
    };
    for info in [
        &dima_model::stream_markers::INFO,
        &dima_model::stream_participants::INFO,
        &dima_model::stream_viewer_snapshots::INFO,
        &dima_model::domain_events::INFO,
    ] {
        let mut rows = store
            .documents(info.name)
            .clone_with_type::<bson::RawDocumentBuf>()
            .find(doc! {})
            .batch_size(256)
            .await?;
        let mut count = 0;
        while let Some(raw) =
            tokio::time::timeout(std::time::Duration::from_secs(5), rows.try_next()).await??
        {
            (info.decode)(&raw)?;
            count += 1;
        }
        assert!(count > 0);
        eprintln!("{}: {count} real documents decoded", info.name);
    }
    Ok(())
}
