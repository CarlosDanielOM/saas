#[allow(dead_code)]
#[path = "../../../src/workers/raid_analytics.rs"]
mod legacy;
mod support;
#[allow(dead_code)]
#[path = "raid_support/mod.rs"]
mod utils;
use anyhow::{Context, Result};
use bson::{Bson, DateTime, Document, doc};
use dima_core::ManualClock;
use dima_events::{envelope::Envelope, value::Object};
use dima_model::CollectionInfo;
use dima_store::mongo::{MongoStore, WriteContext};
use dima_stream::{raid_analytics::*, raid_subscriptions::*};
use futures_util::TryStreamExt;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
const INFOS: [&CollectionInfo; 5] = [
    &dima_model::raid_analytics_histories::INFO,
    &dima_model::raid_analytics_summaries::INFO,
    &dima_model::domain_events::INFO,
    &dima_model::raid_subscription_preferences::INFO,
    &dima_model::eventsubs::INFO,
];
fn fixture() -> Result<Value> {
    Ok(serde_json::from_str(include_str!("raids-reference.json"))?)
}
fn document(v: &Value) -> Result<Document> {
    Ok(Bson::try_from(v.clone())?
        .as_document()
        .context("document")?
        .clone())
}
fn object(v: &Value) -> Result<Object> {
    Ok(Object::from_bson(&document(v)?))
}
fn analytics(
    store: MongoStore,
    clock: Arc<ManualClock>,
    lease: Arc<ManualClock>,
) -> Result<RaidAnalytics> {
    Ok(RaidAnalytics::new(store, clock, lease, Config::default())?)
}
async fn indexes(store: &MongoStore) -> Result<()> {
    for info in INFOS {
        for spec in info.indexes {
            store
                .documents(info.name)
                .create_index(spec.model())
                .await?;
        }
    }
    Ok(())
}
async fn seed(store: &MongoStore, seed: &Value, now: i64) -> Result<()> {
    let info = INFOS
        .iter()
        .find(|i| Some(i.name) == seed["collection"].as_str())
        .context("collection")?;
    let raw = document(&seed["document"])?;
    let mut p = info.prepare_create(&raw, &mut WriteContext::new(now))?;
    // Existing BSON fixtures retain native widths after model validation; they are not
    // new Mongoose creates. Only numeric fields already accepted by the model are restored.
    if info.name == "raid_analytics_histories" {
        for key in ["viewers", "followsAfter"] {
            if let Some(v) = raw
                .get(key)
                .filter(|v| matches!(v, Bson::Int64(_) | Bson::Double(_)))
            {
                p.document.insert(key, v.clone());
            }
        }
    }
    store.writes(info.name).insert_one(&p).await?;
    Ok(())
}
async fn apply(a: &RaidAnalytics, store: &MongoStore, op: &Value, now: i64) -> Result<Value> {
    let d = document(op)?;
    if let Ok(events) = d.get_array("events") {
        for event in events {
            a.apply_raid_analytics_event(&Envelope::from_document(
                event.as_document().context("event")?,
            )?)
            .await?;
        }
        return Ok(Value::Null);
    }
    if let Ok(e) = d.get_document("event") {
        let e = Envelope::from_document(e)?;
        return Ok(match a.apply_raid_analytics_event(&e).await {
            Ok(()) => Value::Null,
            Err(dima_stream::Error::Invalid(_)) => json!("invalid"),
            Err(e) => return Err(e.into()),
        });
    }
    if op["project"] == true {
        return Ok(json!(a.project_raid_summary_once("owner").await?));
    }
    if let Some(channel) = op["queue"].as_str() {
        a.queue_raid_summary(channel).await?;
    }
    if let Some(s) = op.get("seed") {
        seed(store, s, now).await?;
    }
    Ok(Value::Null)
}
async fn snapshot(store: &MongoStore) -> Result<Value> {
    let mut all = serde_json::Map::new();
    for info in INFOS {
        let rows: Vec<Document> = store
            .documents(info.name)
            .find(doc! {})
            .sort(doc! {"_id":1})
            .await?
            .try_collect()
            .await?;
        let mut values = Vec::new();
        for mut row in rows {
            (info.decode)(&bson::RawDocumentBuf::try_from(&row)?)?;
            if row.contains_key("owner") {
                row.insert("owner", "<owner>");
            }
            values.push(Bson::Document(row).into_canonical_extjson());
        }
        all.insert(info.name.into(), Value::Array(values));
    }
    Ok(Value::Object(all))
}
async fn reads(store: MongoStore, channel: &str) -> Result<Value> {
    let p = RaidSubscriptions::new(store, Arc::new(ManualClock::new(0)));
    let mut result = serde_json::Map::new();
    for direction in [RaidDirection::Incoming, RaidDirection::Outgoing] {
        let condition = raid_condition(channel, direction);
        let mut event = Object::new();
        event.insert(
            "from_broadcaster_user_id",
            dima_events::value::Value::String(channel.into()),
        );
        event.insert(
            "to_broadcaster_user_id",
            dima_events::value::Value::String(channel.into()),
        );
        let mut accept = Vec::new();
        for id in [None, Some("current-in"), Some("current-out"), Some("stale")] {
            accept.push(
                p.accepts_raid_notification(
                    &Subscription {
                        id: id.map(str::to_owned),
                        condition: condition.clone(),
                    },
                    &event,
                )
                .await?,
            );
        }
        result.insert(direction.as_str().into(),json!({"id":raid_preference_id(channel,direction),"deleted":p.is_raid_deleted(channel,direction).await?,"repair":p.should_repair_raid(channel,direction).await?,"accept":accept}));
    }
    Ok(Value::Object(result))
}
#[tokio::test]
async fn recorded_typescript_and_deployed_native_documents() -> Result<()> {
    support::with_store(|store| async move {
        indexes(&store).await?;
        let r = fixture()?;
        let clock = Arc::new(ManualClock::new(0));
        let a = analytics(store.clone(), clock.clone(), clock.clone())?;
        let old = legacy::RaidAnalyticsProjector::new(store.database().clone());
        let recording = std::env::var_os("DIMA_RECORD_RAIDS_NATIVE").is_some();
        let native: Value = if recording {
            Value::Null
        } else {
            serde_json::from_str(include_str!("raids-native-reference.json"))?
        };
        let mut out = Vec::new();
        let mut count = 0;
        for (index, step) in r["steps"].as_array().context("steps")?.iter().enumerate() {
            let now = step["now"].as_i64().context("now")?;
            clock.set(now);
            let op = &step["op"];
            let result = if recording && op["project"] == true {
                json!(old.project_once_at(DateTime::from_millis(now)).await? > 0)
            } else {
                let started = std::time::Instant::now();
                apply(&a, &store, op, now).await.with_context(|| {
                    format!("{} apply after {:?}", step["name"], started.elapsed())
                })?
            };
            let docs = snapshot(&store).await?;
            // Before the first native projection, these are exactly the live TypeScript producer writes.
            if !r["steps"]
                .as_array()
                .context("steps")?
                .iter()
                .take(index + 1)
                .any(|s| s["name"] == "project")
            {
                compare_docs(&docs, &step["documents"])
                    .with_context(|| format!("{} TS producer BSON", step["name"]))?;
                assert_eq!(result, step["result"]);
            }
            let started = std::time::Instant::now();
            let expected_reads = reads(store.clone(), "channel").await.with_context(|| {
                format!(
                    "{} preference reads after {:?}",
                    step["name"],
                    started.elapsed()
                )
            })?;
            assert_eq!(
                expected_reads, step["reads"],
                "{} preferences",
                step["name"]
            );
            if !recording {
                assert_eq!(result, native[index]["result"], "{} return", step["name"]);
                compare_docs(&docs, &native[index]["documents"])
                    .with_context(|| format!("{} BSON", step["name"]))?;
            }
            count += docs
                .as_object()
                .context("docs")?
                .values()
                .filter_map(Value::as_array)
                .map(Vec::len)
                .sum::<usize>();
            out.push(json!({"result":result,"documents":docs}));
        }
        for case in r["extraReads"].as_array().context("reads")? {
            assert_eq!(
                reads(store.clone(), case["channel"].as_str().context("channel")?).await?,
                case["expected"]
            );
        }
        if recording {
            std::fs::write(
                concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/tests/raids-native-reference.json"
                ),
                serde_json::to_string_pretty(&out)? + "\n",
            )?;
        }
        for case in r["pure"].as_array().context("pure")? {
            let c = object(&case["condition"])?;
            assert_eq!(serde_json::to_value(raid_direction(&c))?, case["direction"]);
            assert_eq!(raid_config_type("channel.raid", &c), case["config"]);
        }
        for case in r["ranges"].as_array().context("ranges")? {
            assert_eq!(
                raid_range_start(
                    case["days"].as_u64().context("days")? as u32,
                    DateTime::from_millis(case["now"].as_i64().context("now")?)
                )
                .timestamp_millis(),
                case["start"].as_i64().context("start")?
            );
        }
        eprintln!(
            "raids: {} scenarios, {count} exact BSON snapshots, both direction preference reads",
            r["steps"].as_array().context("steps")?.len()
        );
        Ok(())
    })
    .await
}
#[tokio::test]
async fn real_preferences_and_all_raid_collections_decode() -> Result<()> {
    let Some(store) = support::mongo("domdimabot").await? else {
        return Ok(());
    };
    let r: Value = serde_json::from_str(include_str!("raids-real-reference.json"))?;
    for case in r["cases"].as_array().context("cases")? {
        assert_eq!(
            reads(store.clone(), case["channel"].as_str().context("channel")?).await?,
            case["expected"]
        );
    }
    for info in [INFOS[0], INFOS[1], INFOS[3], INFOS[4]] {
        let mut rows = store
            .documents(info.name)
            .clone_with_type::<bson::RawDocumentBuf>()
            .find(doc! {})
            .batch_size(256)
            .await?;
        let mut count = 0;
        while let Some(raw) =
            tokio::time::timeout(Duration::from_secs(30), rows.try_next()).await??
        {
            (info.decode)(&raw)?;
            count += 1;
        }
        assert!(count > 0);
        eprintln!("{}: {count} real documents decoded", info.name);
    }
    eprintln!(
        "{} real preference channels matched",
        r["cases"].as_array().context("cases")?.len()
    );
    Ok(())
}
async fn before_project(
    store: &MongoStore,
    r: &Value,
) -> Result<(RaidAnalytics, Arc<ManualClock>, Arc<ManualClock>, usize)> {
    indexes(store).await?;
    let clock = Arc::new(ManualClock::new(0));
    let lease = Arc::new(ManualClock::new(0));
    let a = analytics(store.clone(), clock.clone(), lease.clone())?;
    let steps = r["steps"].as_array().context("steps")?;
    let index = steps
        .iter()
        .position(|s| s["name"] == "project")
        .context("project")?;
    for step in steps.iter().take(index) {
        let now = step["now"].as_i64().context("now")?;
        clock.set(now);
        lease.set(now);
        apply(&a, store, &step["op"], now).await?;
    }
    Ok((a, clock, lease, index))
}
#[tokio::test]
async fn interruption_at_each_write_and_two_processes() -> Result<()> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let r = fixture()?;
    let n = Arc::new(AtomicUsize::new(0));
    support::with_store(|store| {
        let r = r.clone();
        let n = n.clone();
        async move {
            let (a, _, _, _) = before_project(&store, &r).await?;
            let a = a.with_write_hook(Arc::new(move || {
                n.fetch_add(1, Ordering::SeqCst);
                Box::pin(async {})
            }));
            a.project_raid_summary_once("control").await?;
            Ok(())
        }
    })
    .await?;
    let writes = n.load(Ordering::SeqCst);
    assert!(writes >= 4);
    for cut in 1..=writes {
        let r = r.clone();
        support::with_store(|store|async move{let(a,clock,lease,index)=before_project(&store,&r).await?;let n=Arc::new(AtomicUsize::new(0));let stop=Arc::new(tokio::sync::Notify::new());let signal=stop.clone();let fault=analytics(store.clone(),clock,lease.clone())?.with_write_hook(Arc::new(move||{let hit=n.fetch_add(1,Ordering::SeqCst)+1==cut;let signal=signal.clone();Box::pin(async move{if hit{signal.notify_one();std::future::pending::<()>().await;}})}));let mut task=tokio::spawn(async move{fault.project_raid_summary_once("dead").await});
 tokio::select!{_=stop.notified()=>{},result=&mut task=>anyhow::bail!("projection stopped before write {cut}: {result:?}"),_=tokio::time::sleep(Duration::from_secs(180))=>{task.abort();let _=task.await;anyhow::bail!("write {cut} not observed");}}
 task.abort();assert!(task.await.is_err_and(|e|e.is_cancelled()));lease.advance(61_000);while a.project_raid_summary_once("repair").await? {}let docs=snapshot(&store).await?;let native:Value=serde_json::from_str(include_str!("raids-native-reference.json"))?;compare_docs(&docs,&native[index+1]["documents"]).with_context(||format!("cut {cut}"))?;Ok(())}).await?;
    }
    support::with_store(|store| {
        let r = r.clone();
        async move {
            let (_, _, _, index) = before_project(&store, &r).await?;
            use tokio::io::AsyncWriteExt;
            let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await?;
            let mut first=tokio::process::Command::new(std::env::current_exe()?).args(["--exact","raid_child","--nocapture"])
                .env("DIMA_RAID_CHILD_DB",store.database().name()).env("DIMA_RAID_CHILD_OWNER","race-a")
                .env("DIMA_RAID_BARRIER",listener.local_addr()?.to_string()).kill_on_drop(true).spawn()?;
            // Connection is made only after the first process commits its lease claim.
            let mut connection=tokio::select!{
                accepted=listener.accept()=>accepted?.0,
                status=first.wait()=>anyhow::bail!("first process ended before claim barrier: {status:?}"),
                _=tokio::time::sleep(Duration::from_secs(180))=>{first.kill().await?;anyhow::bail!("claim barrier not reached");}
            };
            let state=store.documents("raid_analytics_summaries").find_one(doc!{"_id":"channel"}).await?.context("claimed summary")?;
            assert_eq!(state.get_str("owner")?,"race-a");
            let mut second=tokio::process::Command::new(std::env::current_exe()?).args(["--exact","raid_child","--nocapture"])
                .env("DIMA_RAID_CHILD_DB",store.database().name()).env("DIMA_RAID_CHILD_OWNER","race-b").kill_on_drop(true).spawn()?;
            assert!(tokio::time::timeout(Duration::from_secs(180),second.wait()).await??.success());
            connection.write_all(&[1]).await?;
            assert!(tokio::time::timeout(Duration::from_secs(180),first.wait()).await??.success());
            let native: Value = serde_json::from_str(include_str!("raids-native-reference.json"))?;
            let (a, _, _, _) = {
                let now = r["steps"][index]["now"].as_i64().context("now")?;
                let clock = Arc::new(ManualClock::new(now));
                (analytics(store.clone(), clock.clone(), clock)?, (), (), ())
            };
            while a.project_raid_summary_once("drain").await? {}
            compare_docs(&snapshot(&store).await?, &native[index + 1]["documents"])?;
            Ok(())
        }
    })
    .await?;
    eprintln!(
        "raids: cancellation recovered at all {writes} committed write boundaries; two OS processes converged"
    );
    Ok(())
}
#[tokio::test]
async fn raid_child() -> Result<()> {
    let Ok(db) = std::env::var("DIMA_RAID_CHILD_DB") else {
        return Ok(());
    };
    assert!(db.starts_with("dima_test_stream_"));
    let store = support::mongo(&db).await?.context("store")?;
    let r = fixture()?;
    let now = r["steps"]
        .as_array()
        .context("steps")?
        .iter()
        .find(|s| s["name"] == "project")
        .context("project")?["now"]
        .as_i64()
        .context("now")?;
    let clock = Arc::new(ManualClock::new(now));
    let mut a = analytics(store, clock.clone(), clock)?;
    if let Ok(address) = std::env::var("DIMA_RAID_BARRIER") {
        use tokio::io::AsyncReadExt;
        let fired = Arc::new(std::sync::atomic::AtomicBool::new(false));
        a = a.with_write_hook(Arc::new(move || {
            let first = !fired.swap(true, std::sync::atomic::Ordering::SeqCst);
            let address = address.clone();
            Box::pin(async move {
                if first {
                    let mut stream = tokio::net::TcpStream::connect(address)
                        .await
                        .expect("loopback barrier");
                    let mut byte = [0];
                    stream
                        .read_exact(&mut byte)
                        .await
                        .expect("release claim barrier");
                }
            })
        }));
    }
    let owner = std::env::var("DIMA_RAID_CHILD_OWNER")?;
    let published = a.project_raid_summary_once(&owner).await?;
    if owner == "race-b" {
        assert!(
            !published,
            "a competing process must not claim the held lease"
        );
    }
    Ok(())
}

// Mongo $group supplies no direction order; preserve every value/type, normalize only that
// explicitly unordered two-element totals array. Recent/top arrays remain byte-order checked.
fn compare_docs(actual: &Value, expected: &Value) -> Result<()> {
    fn totals(mut value: Value) -> Value {
        if let Some(rows) = value
            .get_mut("raid_analytics_summaries")
            .and_then(Value::as_array_mut)
        {
            for row in rows {
                for period in ["7", "30"] {
                    if let Some(t) = row
                        .get_mut("payload")
                        .and_then(|p| p.get_mut(period))
                        .and_then(|p| p.get_mut("totals"))
                        .and_then(Value::as_array_mut)
                    {
                        t.sort_by_key(|r| r["_id"].to_string());
                    }
                }
            }
        }
        value
    }
    fn difference(a: &Value, b: &Value, path: String) -> Option<String> {
        if a == b {
            return None;
        }
        match (a, b) {
            (Value::Object(a), Value::Object(b)) => {
                for k in a.keys().chain(b.keys()) {
                    if let Some(d) = difference(
                        a.get(k).unwrap_or(&Value::Null),
                        b.get(k).unwrap_or(&Value::Null),
                        format!("{path}.{k}"),
                    ) {
                        return Some(d);
                    }
                }
            }
            (Value::Array(a), Value::Array(b)) => {
                if a.len() != b.len() {
                    return Some(format!("{path}: lengths {} != {}", a.len(), b.len()));
                }
                for (i, (a, b)) in a.iter().zip(b).enumerate() {
                    if let Some(d) = difference(a, b, format!("{path}[{i}]")) {
                        return Some(d);
                    }
                }
            }
            _ => return Some(format!("{path}: {a} != {b}")),
        }
        Some(format!("{path}: differing keys"))
    }
    let a = totals(actual.clone());
    let b = totals(expected.clone());
    if let Some(d) = difference(&a, &b, String::new()) {
        anyhow::bail!("{d}");
    }
    Ok(())
}
