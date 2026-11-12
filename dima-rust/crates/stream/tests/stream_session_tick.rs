#![allow(clippy::unwrap_used)]
mod support;
mod tick_support;
use anyhow::{Context, Result, ensure};
use bson::{Document, doc};
use dima_core::Shutdown;
use dima_http::testing::MockServer;
use dima_stream::stream_session_tick::*;
use futures_util::{FutureExt, TryStreamExt};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    panic::AssertUnwindSafe,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tick_support::*;
async fn with_context<F, Fut>(test: F) -> Result<()>
where
    F: FnOnce(Arc<Contextual>) -> Fut,
    Fut: std::future::Future<Output = Result<()>>,
{
    support::with_store(|store| async move {
        let Some(cache) = support::cache().await? else {
            return Ok(());
        };
        let prefix = format!("{}:", store.database().name());
        let c = Arc::new(Contextual::new(store, cache.clone()).await?);
        let result = AssertUnwindSafe(test(c)).catch_unwind().await;
        support::cleanup(&cache, &prefix).await?;
        match result {
            Ok(r) => r,
            Err(p) => std::panic::resume_unwind(p),
        }
    })
    .await
}
fn failed_channels(step: &Value, responses: &[Value]) -> Result<HashSet<String>> {
    let mut failed = HashSet::new();
    for (request, response) in step["requests"]
        .as_array()
        .context("requests")?
        .iter()
        .zip(responses)
    {
        let valid_body = response["body"]
            .as_object()
            .and_then(|o| o.get("data"))
            .is_some_and(Value::is_array);
        let returned: HashSet<_> = response["body"]["data"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|r| r["user_id"].as_str())
            .collect();
        if response["body"]["pagination"]["cursor"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
        {
            for pair in request["target"]
                .as_str()
                .context("target")?
                .split('?')
                .nth(1)
                .unwrap_or_default()
                .split('&')
            {
                if let Some(id) = pair.strip_prefix("user_id=")
                    && !returned.contains(id)
                {
                    failed.insert(id.into());
                }
            }
        }
        let status = response["status"].as_u64().unwrap_or(200);
        if !(200..300).contains(&status) || response["timeout"] == true || !valid_body {
            for pair in request["target"]
                .as_str()
                .context("target")?
                .split('?')
                .nth(1)
                .unwrap_or_default()
                .split('&')
            {
                if let Some(id) = pair.strip_prefix("user_id=") {
                    failed.insert(id.into());
                }
            }
        }
    }
    Ok(failed)
}
fn safe_expected(case: &Value, step: &Value, failed: &HashSet<String>) -> Result<Value> {
    let mut expected = step["documents"].clone();
    if failed.is_empty() {
        return Ok(expected);
    }
    let sessions = expected["streamsessions"]
        .as_array_mut()
        .context("sessions")?;
    sessions.retain(|d| !failed.contains(d["channelID"].as_str().unwrap_or_default()));
    sessions.extend(
        case["seed"]["streamsessions"]
            .as_array()
            .context("seed")?
            .iter()
            .filter(|d| failed.contains(d["channelID"].as_str().unwrap_or_default()))
            .cloned(),
    );
    sessions.sort_by_key(|v| v["_id"].to_string());
    expected["streamviewersnapshots"]
        .as_array_mut()
        .context("snapshots")?
        .retain(|d| !failed.contains(d["channelID"].as_str().unwrap_or_default()));
    expected["cron_job_intents"]
        .as_array_mut()
        .context("jobs")?
        .retain(|d| !failed.contains(d["payload"]["channelID"].as_str().unwrap_or_default()));
    Ok(expected)
}
#[tokio::test]
async fn recorded_tick_documents_cache_and_ordered_helix_requests() -> Result<()> {
    with_context(|c| async move {
        let fixture = recording()?;
        for case in fixture["cases"].as_array().context("cases")? {
            c.seed(
                &case["seed"],
                &case["board"],
                &case["ids"],
                case.get("order"),
            )
            .await?;
            let server = MockServer::start().await?;
            let twitch = c.twitch(&server)?;
            let site = c.site();
            let tick = c.tick(case["name"].as_str().unwrap().contains("timeout"))?;
            let all = case["responses"].as_array().context("responses")?;
            responses(&server, all);
            let mut offset = 0;
            for (index, step) in case["steps"]
                .as_array()
                .context("steps")?
                .iter()
                .enumerate()
            {
                eprintln!("recorded tick case {} step {index}", case["name"]);
                c.random.0.store(
                    step["randomBefore"].as_u64().context("random")? as u8,
                    Ordering::SeqCst,
                );
                let id = scheduled_tick_id(NOW + index as i64 * 300000);
                let out = if step["kind"] == "startup" {
                    tick.reconcile_live_sessions_on_startup(
                        &id,
                        &twitch,
                        &site,
                        &c.producer(),
                        &Shutdown::new(),
                    )
                    .await?
                } else {
                    tick.tick(&id, &twitch, &site, &c.producer(), &Shutdown::new())
                        .await?
                };
                ensure!(
                    [TickOutcome::Complete, TickOutcome::Partial].contains(&out),
                    "{} outcome {out:?}",
                    case["name"]
                );
                let count = step["requests"].as_array().context("requests")?.len();
                let failed = failed_channels(step, &all[offset..offset + count])?;
                let actual = c.snapshot().await?;
                ensure!(
                    actual["documents"] == safe_expected(case, step, &failed)?,
                    "{} step {index} BSON {actual} != {}",
                    case["name"],
                    safe_expected(case, step, &failed)?
                );
                cache_equal(&actual["cache"], &step["cache"])?;
                let observed = requests(&server);
                ensure!(
                    observed.as_array().unwrap().get(offset..offset + count)
                        == step["requests"].as_array().map(Vec::as_slice),
                    "{} requests {observed} != {}",
                    case["name"],
                    step["requests"]
                );
                ensure!(
                    observed.as_array().unwrap().len() == offset + count,
                    "unexpected requests {observed}"
                );
                offset += count;
                c.assert_finished().await?;
            }
        }
        Ok(())
    })
    .await
}
#[tokio::test]
async fn reference_failed_polls_and_overlap_reproduce_data_loss() -> Result<()> {
    let f = recording()?;
    for name in [
        "401-twice",
        "500-twice",
        "timeout-twice",
        "malformed-twice",
        "wrong-shape-twice",
    ] {
        let case = f["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == name)
            .context("case")?;
        let last = case["steps"].as_array().unwrap().last().unwrap();
        ensure!(
            last["documents"]["streamsessions"][0]["status"] == "orphaned",
            "reference did not falsely orphan {name}"
        );
        ensure!(
            last["documents"]["cron_job_intents"]
                .as_array()
                .unwrap()
                .len()
                == 1
        );
    }
    let page = f["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "paginated-response")
        .context("pagination")?;
    let missing = page["steps"][0]["documents"]["streamsessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["channelID"] == "21")
        .context("missing channel")?;
    ensure!(
        missing["status"] == "orphaned",
        "reference cursor did not falsely orphan missing channel"
    );
    ensure!(
        f["race"]["documents"]["streamviewersnapshots"]
            .as_array()
            .unwrap()
            .len()
            == 2
    );
    ensure!(f["race"]["documents"]["streamsessions"][0]["sample_count"]["$numberInt"] == "1");
    // Capture source replay bugs separately; Rust's recovery is compared with the once-only result.
    ensure!(
        f["faults"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["documents"] != v["once"]["documents"])
    );
    Ok(())
}
#[tokio::test]
async fn cancellation_after_every_tick_write_resumes_once() -> Result<()> {
    with_context(|c| async move {
        let fixture = recording()?;
        for kind in ["sample", "close", "board", "supersede"] {
            let source = fixture["faults"]
                .as_array()
                .unwrap()
                .iter()
                .find(|v| v["name"] == kind)
                .context("fault")?;
            let board = &source["board"];
            let empty = json!([]);
            c.seed(&source["seed"], board, &empty, None).await?;
            let server = MockServer::start().await?;
            responses(&server, &[source["response"].clone()]);
            let twitch = c.twitch(&server)?;
            let site = c.site();
            let n = Arc::new(AtomicUsize::new(0));
            let hits = n.clone();
            let tick = c.tick(false)?.with_write_hook(Arc::new(move || {
                hits.fetch_add(1, Ordering::SeqCst);
                Box::pin(async {})
            }));
            let id = scheduled_tick_id(NOW);
            tick.tick(&id, &twitch, &site, &c.producer(), &Shutdown::new())
                .await?;
            let writes = n.load(Ordering::SeqCst);
            for cut in 1..=writes {
                c.seed(&source["seed"], board, &empty, None).await?;
                let server = MockServer::start().await?;
                responses(
                    &server,
                    &[source["response"].clone(), source["response"].clone()],
                );
                let twitch = c.twitch(&server)?;
                let site = c.site();
                let signal = Arc::new(tokio::sync::Notify::new());
                let notify = signal.clone();
                let count = Arc::new(AtomicUsize::new(0));
                let tick = c.tick(false)?.with_write_hook(Arc::new(move || {
                    let hit = count.fetch_add(1, Ordering::SeqCst) + 1 == cut;
                    let notify = notify.clone();
                    Box::pin(async move {
                        if hit {
                            notify.notify_one();
                            std::future::pending::<()>().await;
                        }
                    })
                }));
                let stop = Shutdown::new();
                let child_stop = stop.clone();
                let child_c = c.clone();
                let id = scheduled_tick_id(NOW);
                let child_id = id.clone();
                let child_tw = twitch.clone();
                let child_site = site.clone();
                let child = tokio::spawn(async move {
                    tick.tick(
                        &child_id,
                        &child_tw,
                        &child_site,
                        &child_c.producer(),
                        &child_stop,
                    )
                    .await
                });
                tokio::time::timeout(Duration::from_secs(120), signal.notified()).await?;
                stop.trigger();
                ensure!(
                    tokio::time::timeout(Duration::from_secs(120), child).await???
                        == TickOutcome::Cancelled
                );
                let out = c
                    .tick(false)?
                    .tick(&id, &twitch, &site, &c.producer(), &Shutdown::new())
                    .await?;
                ensure!([TickOutcome::Complete, TickOutcome::AlreadyComplete].contains(&out));
                let actual = c.snapshot().await?;
                ensure!(
                    actual["documents"] == source["once"]["documents"],
                    "{kind} cut {cut}: {actual} != {}",
                    source["once"]
                );
                cache_equal(&actual["cache"], &source["once"]["cache"])?;
                c.assert_finished().await?;
            }
            eprintln!(
                "{kind}: {writes} confirmed Mongo/cache/job cancellation boundaries recovered"
            );
        }
        Ok(())
    })
    .await
}
#[tokio::test]
async fn two_processes_coalesce_one_tick_and_reject_older_slots() -> Result<()> {
    with_context(|c| async move {
        let f = recording()?;
        let case = f["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == "one")
            .context("one")?;
        c.seed(&case["seed"], &case["board"], &case["ids"], None)
            .await?;
        let server = MockServer::start().await?;
        responses(&server, case["responses"].as_array().unwrap());
        let mut children = Vec::new();
        for _ in 0..2 {
            children.push(
                tokio::process::Command::new(std::env::current_exe()?)
                    .args(["--exact", "tick_process_child", "--nocapture"])
                    .env("DIMA_TICK_RUST_DB", c.store.database().name())
                    .env("DIMA_TICK_RUST_HTTP", server.url())
                    .kill_on_drop(true)
                    .spawn()?,
            );
        }
        let barrier = c.store.documents("stream_tick_test_barrier");
        tokio::time::timeout(Duration::from_secs(120), async {
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
                tokio::time::timeout(Duration::from_secs(180), child.wait())
                    .await??
                    .success()
            );
        }
        let outcomes: Vec<Document> = c
            .store
            .documents("stream_tick_test_results")
            .find(doc! {})
            .await?
            .try_collect()
            .await?;
        ensure!(outcomes.len() == 2);
        ensure!(
            outcomes
                .iter()
                .filter(|d| d.get_str("outcome").ok() == Some("Complete"))
                .count()
                == 1
        );
        ensure!(
            outcomes
                .iter()
                .filter(|d| d.get_str("outcome").ok() == Some("Busy"))
                .count()
                == 1
        );
        let actual = c.snapshot().await?;
        ensure!(
            actual["documents"] == case["steps"][0]["documents"],
            "coalesced snapshot {actual}"
        );
        cache_equal(&actual["cache"], &case["steps"][0]["cache"])?;
        ensure!(requests(&server) == case["steps"][0]["requests"]);
        let twitch = c.twitch(&server)?;
        for time in [NOW, NOW - 300000] {
            ensure!(
                c.tick(false)?
                    .tick(
                        &scheduled_tick_id(time),
                        &twitch,
                        &c.site(),
                        &c.producer(),
                        &Shutdown::new()
                    )
                    .await?
                    == TickOutcome::AlreadyComplete
            );
        }
        ensure!(server.requests().len() == 1);
        c.assert_finished().await?;
        Ok(())
    })
    .await
}
#[tokio::test]
async fn tick_process_child() -> Result<()> {
    let Ok(database) = std::env::var("DIMA_TICK_RUST_DB") else {
        return Ok(());
    };
    ensure!(database.starts_with("dima_test_stream_"));
    let store = support::mongo(&database).await?.context("store")?;
    let cache = support::cache().await?.context("cache")?;
    let c = Arc::new(Contextual::new(store, cache).await?);
    let twitch = c.twitch_at(&std::env::var("DIMA_TICK_RUST_HTTP")?)?;
    let barrier = c.store.documents("stream_tick_test_barrier");
    barrier
        .insert_one(doc! {"_id":i64::from(std::process::id()),"ready":true})
        .await?;
    tokio::time::timeout(Duration::from_secs(120), async {
        loop {
            if barrier.find_one(doc! {"_id":"release"}).await?.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        Ok::<(), mongodb::error::Error>(())
    })
    .await??;
    // The lease winner waits for the loser's observable Busy result. No timing race is assumed.
    let store = c.store.clone();
    let first = Arc::new(AtomicUsize::new(0));
    let tick = c.tick(false)?.with_write_hook(Arc::new(move || {
        let first = first.fetch_add(1, Ordering::SeqCst) == 0;
        let store = store.clone();
        Box::pin(async move {
            if first {
                let _ = tokio::time::timeout(Duration::from_secs(120), async {
                    loop {
                        if store
                            .documents("stream_tick_test_results")
                            .count_documents(doc! {})
                            .await
                            .unwrap_or(0)
                            > 0
                        {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                })
                .await;
            }
        })
    }));
    let outcome = tick
        .tick(
            &scheduled_tick_id(NOW),
            &twitch,
            &c.site(),
            &c.producer(),
            &Shutdown::new(),
        )
        .await?;
    c.store
        .documents("stream_tick_test_results")
        .insert_one(doc! {"outcome":format!("{outcome:?}")})
        .await?;
    Ok(())
}
#[tokio::test]
async fn real_snapshot_and_session_reads_decode() -> Result<()> {
    let Some(store) = support::mongo("domdimabot").await? else {
        return Ok(());
    };
    for info in [
        &dima_model::stream_sessions::INFO,
        &dima_model::stream_viewer_snapshots::INFO,
    ] {
        let rows: Vec<bson::RawDocumentBuf> = store
            .documents(info.name)
            .clone_with_type()
            .find(doc! {})
            .limit(100)
            .await?
            .try_collect()
            .await?;
        ensure!(!rows.is_empty());
        for row in &rows {
            (info.decode)(row)?;
        }
        eprintln!(
            "{}: {} real documents decoded read-only",
            info.name,
            rows.len()
        );
    }
    Ok(())
}
#[tokio::test]
async fn channel_bound_refuses_work_then_recovers_without_mutation() -> Result<()> {
    with_context(|c| async move {
        let f = recording()?;
        let case = f["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == "two-batches")
            .context("case")?;
        c.seed(
            &case["seed"],
            &case["board"],
            &case["ids"],
            case.get("order"),
        )
        .await?;
        let server = MockServer::start().await?;
        let twitch = c.twitch(&server)?;
        let small = StreamSessionTick::new(
            c.store.clone(),
            c.cache.clone(),
            c.clock.clone(),
            Arc::new(dima_core::SystemRandom),
            Config {
                key_prefix: c.prefix.clone(),
                store_deadline: Duration::from_secs(60),
                max_channels: 1,
                ..Default::default()
            },
        )?;
        ensure!(
            small
                .fetch_live_streams_by_channel_ids(&twitch, &["1".into(), "2".into()])
                .await
                .is_err()
        );
        ensure!(server.requests().is_empty());
        let id = scheduled_tick_id(NOW);
        ensure!(
            small
                .tick(&id, &twitch, &c.site(), &c.producer(), &Shutdown::new())
                .await
                .is_err()
        );
        ensure!(server.requests().is_empty());
        ensure!(c.snapshot().await?["documents"] == case["seed"]);
        responses(&server, case["responses"].as_array().unwrap());
        ensure!(
            c.tick(false)?
                .tick(&id, &twitch, &c.site(), &c.producer(), &Shutdown::new())
                .await?
                == TickOutcome::Complete
        );
        ensure!(c.snapshot().await?["documents"] == case["steps"][0]["documents"]);
        c.assert_finished().await?;
        Ok(())
    })
    .await
}
