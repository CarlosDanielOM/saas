//! The ported protocols against the local Dragonfly: the plan cache fence and the cron job queue.
//! The fence keys embed a channel id, so each test uses its own id under a unique prefix and
//! deletes its keys. Logical database 12. Skipped when `DIMA_TEST_DRAGONFLY` is not set.

mod dragonfly_support;

use anyhow::{Result, ensure};
use dima_store::dragonfly::cron_queue::{
    self, CronQueueConfig, CronQueueError, EnqueueCronJobInput, STREAM_MEMORY_QUEUE_KEY,
};
use dima_store::dragonfly::plan_cache_fence::{
    self, Acceptance, AccountRead, AccountVersion, CreditMode, Exhaustion,
    PLAN_CACHE_VERSION_FIELD, PlanCacheFence, TtlSeconds,
};
use dima_store::dragonfly::{Dragonfly, QueueItem, SetOptions, Ttl};
use dragonfly_support::{connect, prefix};
use serde_json::json;

const DB: u8 = 12;

/// A unique channel id (fence keys are `twitch:{id}:...`), and the keys to delete afterwards.
fn channel(name: &str) -> String {
    prefix(name).replace(':', "-")
}

async fn delete_channel(df: &Dragonfly, id: &str) -> Result<()> {
    let keys = [
        plan_cache_fence::plan_cache_fence_key(id),
        plan_cache_fence::account_cache_key(id),
        plan_cache_fence::credits_cache_key(id),
        plan_cache_fence::snapshot_version_key(id),
        format!("twitch:{id}:ai:exhaust"),
        format!("{id}:ai:exhaust"),
        format!("billing-context:{id}"),
    ];
    let keys: Vec<&str> = keys.iter().map(String::as_str).collect();
    df.del(&keys).await?;
    Ok(())
}

#[tokio::test]
async fn fence_versions_compare_as_bytes_and_equal_versions_pass() -> Result<()> {
    let Some(df) = connect(DB).await? else {
        return Ok(());
    };
    let id = channel("fence");
    let fence = PlanCacheFence::new(df.clone());
    let v_old = plan_cache_fence::plan_cache_version(Some(1_700_000_000_000), Some("evt-a"))?;
    let v_new = plan_cache_fence::plan_cache_version(Some(1_800_000_000_000), Some("evt-b"))?;

    // No fence yet: any version writes.
    let fields = [
        ("id", id.as_str()),
        ("name", "Ñandú 🎉"),
        (PLAN_CACHE_VERSION_FIELD, "stale"),
    ];
    ensure!(fence.write_account(&id, &v_old, &fields).await? == Acceptance::Accepted);
    let stored = df
        .hgetall(&plan_cache_fence::account_cache_key(&id))
        .await?;
    ensure!(
        stored
            == [
                ("id".to_owned(), id.clone()),
                ("name".into(), "Ñandú 🎉".into()),
                (PLAN_CACHE_VERSION_FIELD.into(), v_old.clone())
            ],
        "{stored:?}"
    );
    let AccountRead::Accepted(snapshot) = fence.read_account(&id).await? else {
        anyhow::bail!("not accepted")
    };
    ensure!(snapshot.version() == v_old);

    // Invalidation raises the fence and deletes the account hash.
    ensure!(
        fence
            .invalidate_plan(&id, &v_new, &format!("billing-context:{id}"))
            .await?
            == Acceptance::Accepted
    );
    ensure!(fence.read_account(&id).await? == AccountRead::Missing);
    ensure!(
        df.get_text(&plan_cache_fence::plan_cache_fence_key(&id))
            .await?
            == Some(v_new.clone())
    );
    // An older invalidation is refused; an equal one passes.
    ensure!(fence.invalidate_plan(&id, &v_old, "unused").await? == Acceptance::Rejected);
    ensure!(fence.invalidate_plan(&id, &v_new, "unused").await? == Acceptance::Accepted);
    // A stale write is refused, an equal version accepted.
    ensure!(fence.write_account(&id, &v_old, &fields).await? == Acceptance::Rejected);
    ensure!(fence.write_account(&id, &v_new, &fields).await? == Acceptance::Accepted);
    // Byte order, not numeric: "9…" > "10…".
    let nine = "9:x";
    df.set(
        &plan_cache_fence::plan_cache_fence_key(&id),
        nine.as_bytes(),
        SetOptions::default(),
    )
    .await?;
    ensure!(fence.write_account(&id, "10:x", &fields).await? == Acceptance::Rejected);
    ensure!(fence.read_account(&id).await? == AccountRead::Stale);

    // CHECK publishes the aggregate only when every version is fresh.
    let aggregate = r#"[{"id":"x","name":"é"}]"#;
    let fresh = [AccountVersion {
        id: &id,
        version: "9:x",
    }];
    ensure!(fence.check_accounts(&fresh, Some(aggregate)).await? == Acceptance::Accepted);
    let stale = [AccountVersion {
        id: &id,
        version: "8:x",
    }];
    ensure!(fence.check_accounts(&stale, Some("[]")).await? == Acceptance::Rejected);
    // (The aggregate key is shared: remove what this test published.)
    if df
        .get(plan_cache_fence::ACCOUNTS_CACHE_KEY)
        .await?
        .as_deref()
        == Some(aggregate.as_bytes())
    {
        df.del(&[plan_cache_fence::ACCOUNTS_CACHE_KEY]).await?;
    }
    let reads = fence
        .read_accounts(&[&id, "dima-test-missing-account"])
        .await?;
    ensure!(
        reads == [AccountRead::Stale, AccountRead::Missing],
        "{reads:?}"
    );
    delete_channel(&df, &id).await
}

#[tokio::test]
async fn accept_credits_read_mode_needs_the_exact_bytes() -> Result<()> {
    let Some(df) = connect(DB).await? else {
        return Ok(());
    };
    let id = channel("credits");
    let fence = PlanCacheFence::new(df.clone());
    let ttl = TtlSeconds::new(3600)?;
    let version = plan_cache_fence::plan_cache_version(Some(1_790_000_000_000), Some("e"))?;
    // As Lua's cjson writes it: escaped slash, its own key order.
    let raw = r#"{"status":"available","updatedAt":"2026\/11\/11","balance":10,"used":5}"#;
    ensure!(
        fence
            .accept_credits(&id, &version, raw, CreditMode::Write, false, ttl)
            .await?
            == Acceptance::Accepted
    );
    ensure!(matches!(
        df.ttl(&plan_cache_fence::credits_cache_key(&id)).await?,
        Ttl::Seconds(3599 | 3600)
    ));
    ensure!(
        fence
            .accept_credits(&id, &version, raw, CreditMode::Read, true, ttl)
            .await?
            == Acceptance::Accepted
    );
    ensure!(df.get_text(&format!("twitch:{id}:ai:exhaust")).await? == Some("true".into()));
    ensure!(df.get_text(&format!("{id}:ai:exhaust")).await? == Some("true".into()));
    // The same JSON re-serialised is a different value: refused.
    let reparsed: serde_json::Value = serde_json::from_str(raw)?;
    let rewritten = dima_text::to_js_json(&reparsed);
    ensure!(rewritten != raw);
    ensure!(
        fence
            .accept_credits(&id, &version, &rewritten, CreditMode::Read, false, ttl)
            .await?
            == Acceptance::Rejected
    );
    // Sync with Keep leaves the exhaustion keys; Available deletes both.
    let snapshot = plan_cache_fence::plan_cache_version(Some(1_790_000_000_001), Some("s"))?;
    ensure!(
        fence
            .sync_credits(&id, &snapshot, None, Exhaustion::Keep, ttl, &version)
            .await?
            == Acceptance::Accepted
    );
    ensure!(df.exists(&[&format!("{id}:ai:exhaust")]).await? == 1);
    ensure!(
        fence
            .sync_credits(
                &id,
                &snapshot,
                Some("{}"),
                Exhaustion::Available,
                ttl,
                &version
            )
            .await?
            == Acceptance::Accepted
    );
    ensure!(df.exists(&[&format!("{id}:ai:exhaust")]).await? == 0);
    ensure!(
        df.get_text(&plan_cache_fence::credits_cache_key(&id))
            .await?
            == Some("{}".into())
    );
    let older = plan_cache_fence::plan_cache_version(Some(1_790_000_000_000), Some("s"))?;
    ensure!(
        fence
            .sync_credits(&id, &older, Some("[]"), Exhaustion::Keep, ttl, &version)
            .await?
            == Acceptance::Rejected
    );
    delete_channel(&df, &id).await
}

#[tokio::test]
async fn cron_enqueue_is_deduplicated_atomically() -> Result<()> {
    let Some(df) = connect(DB).await? else {
        return Ok(());
    };
    let p = prefix("cron");
    let queue = format!("{p}queue");
    let config = CronQueueConfig::default();
    let input = EnqueueCronJobInput {
        job: "follow-ledger-sync".into(),
        channel_id: Some("123".into()),
        account_id: Some("123".into()),
        dedupe_token: Some(format!("{p}token")),
        dedupe_seconds: Some(120.0),
        data: Some(json!({"reason": "manual_request", "type": "follow-ledger-sync"})),
        queue_key: Some(queue.clone()),
        ..EnqueueCronJobInput::default()
    };
    let now = "2026-11-11T12:00:00.000Z";
    let first = cron_queue::enqueue_cron_job(&df, &input, config, now, "id-1").await?;
    ensure!(first.enqueued && first.message == "Cron job queued");
    let replay = cron_queue::enqueue_cron_job(&df, &input, config, now, "id-2").await?;
    ensure!(!replay.enqueued && replay.message == "Cron job already queued recently");
    let stored: Vec<Vec<u8>> = df
        .query(redis::cmd("LRANGE").arg(&queue).arg(0).arg(-1))
        .await?;
    ensure!(stored == vec![first.job.to_item()?.into_bytes()]);
    let dedupe_key = first.job.dedupe_key.clone().unwrap_or_default();
    ensure!(matches!(
        df.ttl(&dedupe_key).await?,
        Ttl::Seconds(119 | 120)
    ));
    // A popped job parses back and its bytes requeue unchanged.
    let popped = QueueItem::from_popped(stored[0].clone());
    let parsed = cron_queue::parse_cron_queue_job(&popped, now, "unused")?;
    ensure!(parsed.as_ref() == Some(&first.job));
    cron_queue::clear_cron_job_dedupe_by_key(&df, Some(&format!(" {dedupe_key} "))).await?;
    ensure!(df.exists(&[&dedupe_key]).await? == 0);

    // A failed push (wrong type) rolls the marker back and surfaces the error.
    df.set(&queue, b"not a list", SetOptions::default()).await?;
    let failed = cron_queue::enqueue_cron_job(&df, &input, config, now, "id-3").await;
    ensure!(
        matches!(&failed, Err(CronQueueError::Dragonfly(e)) if e.to_string().contains("WRONGTYPE")),
        "{failed:?}"
    );
    ensure!(
        df.exists(&[&dedupe_key]).await? == 0,
        "marker not rolled back"
    );

    // Durable routes are refused here.
    let durable = EnqueueCronJobInput {
        job: "stream-memory-summary".into(),
        queue_key: Some(STREAM_MEMORY_QUEUE_KEY.into()),
        ..EnqueueCronJobInput::default()
    };
    let refused = cron_queue::enqueue_cron_job(&df, &durable, config, now, "id-4").await;
    ensure!(matches!(
        refused,
        Err(CronQueueError::DurableRouteRequired { .. })
    ));
    dragonfly_support::cleanup(&df, &p).await
}

#[tokio::test]
async fn automatic_session_acceptance_survives_dedupe_cleanup() -> Result<()> {
    let Some(df) = connect(DB).await? else {
        return Ok(());
    };
    let p = prefix("cron-accept");
    let session = format!("{p}session");
    let input = EnqueueCronJobInput {
        job: "summary".into(),
        dedupe_token: Some(format!("{p}token")),
        queue_key: Some(format!("{p}queue")),
        data: Some(json!({"source": "stream_offline", "sessionID": session})),
        ..EnqueueCronJobInput::default()
    };
    let now = "2026-11-11T12:00:00.000Z";
    let config = CronQueueConfig::default();
    ensure!(
        cron_queue::enqueue_cron_job(&df, &input, config, now, "a")
            .await?
            .enqueued
    );
    let acceptance = format!("cron:jobs:accepted:summary::{session}");
    ensure!(df.get_text(&acceptance).await? == Some("1".into()));
    // Worker clears the dedupe marker; the acceptance marker still refuses a resend.
    cron_queue::clear_cron_job_dedupe_by_key(&df, Some(&format!("cron:jobs:dedupe:{p}token")))
        .await?;
    ensure!(
        !cron_queue::enqueue_cron_job(&df, &input, config, now, "b")
            .await?
            .enqueued
    );
    let manual = EnqueueCronJobInput {
        data: Some(json!({"source": "manual", "sessionID": session})),
        ..input.clone()
    };
    ensure!(
        cron_queue::enqueue_cron_job(&df, &manual, config, now, "c")
            .await?
            .enqueued
    );
    df.del(&[&acceptance, &format!("cron:jobs:dedupe:{p}token")])
        .await?;
    dragonfly_support::cleanup(&df, &p).await
}

#[tokio::test]
async fn durable_publish_pushes_once_by_exact_bytes() -> Result<()> {
    let Some(df) = connect(DB).await? else {
        return Ok(());
    };
    let p = prefix("durable");
    let queue = format!("{p}queue");
    let accepted = format!("{p}accepted");
    let item =
        QueueItem::encode(&json!({"id": "x", "job": "stream-memory-summary", "data": {"n": 1}}))?;
    ensure!(cron_queue::publish_durable_cron_job(&df, &queue, Some(&accepted), &item).await?);
    ensure!(!cron_queue::publish_durable_cron_job(&df, &queue, None, &item).await?);
    ensure!(df.get_text(&accepted).await? == Some("1".into()));
    // A re-encoded copy (1.0 for 1) is a different element: LPOS misses and it is pushed.
    let reencoded = QueueItem::from_popped(
        br#"{"id":"x","job":"stream-memory-summary","data":{"n":1.0}}"#.to_vec(),
    );
    ensure!(cron_queue::publish_durable_cron_job(&df, &queue, None, &reencoded).await?);
    let length: i64 = df.query(redis::cmd("LLEN").arg(&queue)).await?;
    ensure!(length == 2);
    dragonfly_support::cleanup(&df, &p).await
}
