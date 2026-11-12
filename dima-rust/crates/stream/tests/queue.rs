mod support;
use anyhow::{Context, Result};
use dima_core::ManualClock;
use dima_store::dragonfly::QueueItem;
use dima_stream::follow_ledger_queue::*;
use std::sync::Arc;

#[tokio::test]
async fn dedupe_lifo_busy_requeue_failure_cleanup_and_unknown_jobs() -> Result<()> {
    let Some(cache) = support::cache().await? else {
        return Ok(());
    };
    let prefix = format!("dima_test_stream_{}:", uuid::Uuid::new_v4().simple());
    let queue = Queue::new(
        cache.clone(),
        Arc::new(ManualClock::new(1_794_355_200_000)),
        Arc::new(dima_core::SystemRandom),
        Config {
            key_prefix: prefix.clone(),
            capacity: 3,
            ..Config::default()
        },
    )?;
    let result: Result<()> = async {
        assert!(
            !queue
                .enqueue_follow_ledger_sync_job(" \u{feff} ", None, None, "invalid")
                .await?
                .enqueued
        );
        let first = queue
            .enqueue_follow_ledger_sync_job(" 👋שם ", Some("  "), Some(" requester "), "one")
            .await?;
        assert!(first.enqueued);
        let job = first.job.context("job")?;
        assert_eq!(job.channel_id.as_deref(), Some("👋שם"));
        assert_eq!(job.data.context("data")?["reason"], "manual_request");
        assert_eq!(job.requested_by.as_deref(), Some("requester"));
        assert!(
            !queue
                .enqueue_follow_ledger_sync_job("👋שם", None, None, "duplicate")
                .await?
                .enqueued
        );
        assert!(matches!(
            cache.ttl(&first.dedupe_key).await?,
            dima_store::dragonfly::Ttl::Seconds(899..=900)
        ));
        queue
            .enqueue_follow_ledger_sync_job("second", None, None, "two")
            .await?;
        let newest = queue.pop().await?.context("newest")?;
        assert_eq!(newest.job.id, "two");
        let raw = newest.raw.as_bytes().to_vec();
        queue.requeue_busy(newest).await?;
        let oldest = queue.pop().await?.context("oldest")?;
        assert_eq!(oldest.job.id, "one");
        // Sync failures consume the job exactly as successes do.
        queue.finish(oldest).await?;
        assert_eq!(cache.exists(&[&first.dedupe_key]).await?, 0);
        let retry = queue.pop().await?.context("retry")?;
        assert_eq!(retry.raw.as_bytes(), raw);
        queue.finish(retry).await?;
        assert!(
            queue
                .accept(QueueItem::from_popped(b"{bad".to_vec()))
                .await?
                .is_none()
        );
        let unknown = br#"{ "id":"u", "job":"other", "requestedAt":"2026-11-11T00:00:00.000Z" }"#;
        assert!(
            queue
                .accept(QueueItem::from_popped(unknown.to_vec()))
                .await?
                .is_none()
        );
        assert_eq!(
            cache
                .lpop(&format!("{prefix}cron:jobs:dead-letter"))
                .await?
                .context("dead letter")?,
            unknown
        );
        for i in 0..3 {
            queue
                .enqueue_follow_ledger_sync_job(
                    &format!("capacity-{i}"),
                    None,
                    None,
                    &i.to_string(),
                )
                .await?;
        }
        assert!(
            queue
                .enqueue_follow_ledger_sync_job("overload", None, None, "overload")
                .await
                .is_err()
        );
        assert_eq!(
            cache
                .exists(&[&format!(
                    "{prefix}{}",
                    get_follow_ledger_dedupe_key("overload")
                )])
                .await?,
            0
        );
        Ok(())
    }
    .await;
    support::cleanup(&cache, &prefix).await?;
    result
}
