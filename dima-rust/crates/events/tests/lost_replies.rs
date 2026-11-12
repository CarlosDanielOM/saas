//! A write that the server commits and whose reply never comes back (the review of the first
//! half, finding 3): intent acceptance, claim, retry and completion, delivery creation and the
//! clearing of the dispatch marker. The proxy delivers the request and drops everything the
//! server answers on that connection, so the caller's deadline passes on an applied write. Each
//! case checks what the caller is told, what is durably true afterwards, and that doing it again
//! converges without a second effect.

mod support;

use anyhow::{Result, anyhow, ensure};
use bson::{Document, doc};
use dima_core::{ManualClock, SeededRandom};
use dima_events::config::EventsConfig;
use dima_events::contracts::policy::CONSUMERS;
use dima_events::dispatch::{DispatchError, DispatchEvent, Dispatcher, ensure_delivery};
use dima_events::jobs::{
    ClaimResult, DurableJobs, JobError, JobQueue, JobsConfig, LEASE_MS, PrepareOptions,
};
use dima_events::producers::{Journal, Owners};
use dima_events::store::StoreError;
use dima_events::value::{Object, Value};
use dima_model::{cron_job_intents, domain_event_deliveries, domain_events};
use dima_store::dragonfly::QueueItem;
use dima_store::dragonfly::cron_queue::CronQueueJob;
use dima_store::mongo::MongoStore;
use std::sync::Arc;
use std::time::Duration;
use support::{Proxy, with_store};

const NOW: i64 = 1_794_392_430_456;
const QUEUE: &str = "cron:stream-memory:queue";
/// A lost reply ends the call at this deadline; long enough for a new connection's handshake
/// (SCRAM in a debug build) when tests run side by side.
const DEADLINE: Duration = Duration::from_millis(2_000);

#[derive(Clone, Copy, Debug)]
struct NoQueue;

impl JobQueue for NoQueue {
    async fn publish(&self, _: &str, _: Option<&str>, _: &QueueItem) -> Result<bool, StoreError> {
        Ok(true)
    }

    async fn marker_exists(&self, _: &str) -> Result<bool, StoreError> {
        Ok(false)
    }
}

fn job(id: &str) -> CronQueueJob {
    CronQueueJob {
        id: id.into(),
        job: "stream-memory-summary".into(),
        requested_at: "2026-11-11T10:20:30.456Z".into(),
        requested_by: None,
        user_id: None,
        account_id: None,
        channel_id: Some("1001".into()),
        data: Some(serde_json::json!({ "reason": "manual" })),
        dedupe_key: Some(format!("cron:jobs:dedupe:{id}")),
    }
}

fn options() -> PrepareOptions {
    PrepareOptions {
        dedupe_seconds: 3600.0,
        acceptance_key: None,
        legacy_accepted: false,
    }
}

/// A store reached through a fresh proxy (a second client, as another process would have).
async fn through(store: &MongoStore) -> Result<Option<(Proxy, MongoStore)>> {
    let Some(address) = support::mongo_address()? else {
        return Ok(None);
    };
    let proxy = Proxy::start_mongo(address).await?;
    let name = store.database().name().to_owned();
    let Some(other) = support::store_through(&proxy, &name).await? else {
        return Ok(None);
    };
    // One round trip so the connection pool and the monitor are up before a trap is armed.
    other.ping().await?;
    Ok(Some((proxy, other)))
}

async fn intent(store: &MongoStore, job_id: &str) -> Result<Document> {
    store
        .documents(cron_job_intents::COLLECTION)
        .find_one(doc! { "jobID": job_id })
        .await?
        .ok_or_else(|| anyhow!("intent {job_id}"))
}

fn timed_out(error: &JobError) -> bool {
    matches!(error, JobError::Store(error @ StoreError::Timeout { .. }) if error.outcome_unknown())
}

async fn jobs(
    store: &MongoStore,
    other: &MongoStore,
    clock: &ManualClock,
) -> Result<DurableJobs<NoQueue>> {
    let report = support::indexes(store, &cron_job_intents::INFO).await?;
    Ok(DurableJobs::new(
        other.clone(),
        NoQueue,
        Arc::new(clock.clone()),
        Arc::new(SeededRandom::new(11)),
        JobsConfig {
            store_deadline: DEADLINE,
            ..JobsConfig::default()
        },
        &report,
    )?)
}

#[tokio::test]
async fn a_lost_acceptance_reply_is_answered_by_the_next_acceptance() -> Result<()> {
    with_store(|store| async move {
        let Some((proxy, other)) = through(&store).await? else {
            return Ok(());
        };
        let clock = ManualClock::new(NOW);
        let jobs = jobs(&store, &other, &clock).await?;
        proxy.lose_reply_to(&[b"insert\0", b"lost-accept"]);
        let told = jobs.prepare(&job("lost-accept"), QUEUE, &options()).await;
        ensure!(
            proxy.replies_lost() == 1,
            "the insert was the trapped request"
        );
        ensure!(
            told.as_ref().is_err_and(timed_out),
            "the caller is told the outcome is unknown: {told:?}"
        );
        // Durably: the intent was accepted.
        let stored = intent(&store, "lost-accept").await?;
        ensure!(stored.get_str("status")? == "queued");
        // The producer asks again (the API answered 5xx): already accepted, one intent.
        let again = jobs.prepare(&job("lost-accept"), QUEUE, &options()).await?;
        ensure!(!again.created && again.status == "queued" && again.job == job("lost-accept"));
        ensure!(
            store
                .documents(cron_job_intents::COLLECTION)
                .count_documents(doc! {})
                .await?
                == 1
        );
        Ok(())
    })
    .await
}

#[tokio::test]
async fn a_claim_whose_reply_was_lost_is_reconciled_by_its_token() -> Result<()> {
    with_store(|store| async move {
        let Some((proxy, other)) = through(&store).await? else {
            return Ok(());
        };
        let clock = ManualClock::new(NOW);
        let jobs = jobs(&store, &other, &clock).await?;
        jobs.prepare(&job("lost-claim"), QUEUE, &options()).await?;
        proxy.lose_reply_to(&[b"findAndModify\0", b"owner-lost-claim"]);
        let claim = match jobs
            .claim(&job("lost-claim"), QUEUE, "owner-lost-claim")
            .await?
        {
            ClaimResult::Claimed {
                claim,
                job: claimed,
            } => {
                ensure!(claimed == job("lost-claim"));
                claim
            }
            other => return Err(anyhow!("expected the reconciled claim, got {other:?}")),
        };
        ensure!(
            proxy.replies_lost() == 1,
            "the claim was the trapped request"
        );
        let stored = intent(&store, "lost-claim").await?;
        ensure!(stored.get_str("status")? == "processing");
        ensure!(
            stored.get_str("token")? == claim.token,
            "the caller holds the stored lease"
        );
        // Nobody else can take it, and the owner completes it.
        ensure!(matches!(
            jobs.claim(&job("lost-claim"), QUEUE, "owner-other").await?,
            ClaimResult::Busy { .. }
        ));
        ensure!(jobs.complete(&claim).await?);
        ensure!(intent(&store, "lost-claim").await?.get_str("status")? == "completed");
        Ok(())
    })
    .await
}

#[tokio::test]
async fn a_lost_claim_reply_found_expired_is_reported_and_never_replayed() -> Result<()> {
    with_store(|store| async move {
        let Some((proxy, other)) = through(&store).await? else {
            return Ok(());
        };
        let clock = ManualClock::new(NOW);
        let jobs = jobs(&store, &other, &clock).await?;
        jobs.prepare(&job("expired-claim"), QUEUE, &options())
            .await?;
        proxy.lose_reply_to(&[b"findAndModify\0", b"owner-expired"]);
        // While the caller waits for the lost reply, its lease runs out.
        let advance = async {
            for _ in 0..200 {
                if proxy.replies_lost() == 1 {
                    clock.advance(LEASE_MS + 1);
                    return Ok(());
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            Err(anyhow!("the claim never reached the server"))
        };
        let expired = job("expired-claim");
        let (told, advanced) = tokio::join!(jobs.claim(&expired, QUEUE, "owner-expired"), advance);
        advanced?;
        ensure!(
            told.as_ref().is_err_and(timed_out),
            "an expired claim is reported as the failure it was: {told:?}"
        );
        // It committed, so the intent sits under a lease nobody holds; nothing replays it.
        ensure!(intent(&store, "expired-claim").await?.get_str("status")? == "processing");
        ensure!(jobs.recover(QUEUE, 10).await?.uncertain == 1);
        ensure!(matches!(
            jobs.claim(&job("expired-claim"), QUEUE, "owner-later")
                .await?,
            ClaimResult::Terminal { .. }
        ));
        ensure!(intent(&store, "expired-claim").await?.get_str("status")? == "uncertain");
        Ok(())
    })
    .await
}

#[tokio::test]
async fn lost_retry_and_completion_replies_leave_the_transition_made_once() -> Result<()> {
    with_store(|store| async move {
        let Some((proxy, other)) = through(&store).await? else {
            return Ok(());
        };
        let clock = ManualClock::new(NOW);
        let jobs = jobs(&store, &other, &clock).await?;

        // Retry: the job is durably queued again for its new time; the claim is spent.
        jobs.prepare(&job("lost-retry"), QUEUE, &options()).await?;
        let ClaimResult::Claimed { claim, .. } =
            jobs.claim(&job("lost-retry"), QUEUE, "owner-retry").await?
        else {
            return Err(anyhow!("claim"));
        };
        proxy.lose_reply_to(&[b"update\0", b"owner-retry", b"queued"]);
        let due = (NOW + 60_000) as f64;
        let told = jobs.retry(&claim, &job("lost-retry"), due).await;
        ensure!(proxy.replies_lost() == 1);
        ensure!(told.as_ref().is_err_and(timed_out), "{told:?}");
        let stored = intent(&store, "lost-retry").await?;
        ensure!(stored.get_str("status")? == "queued" && !stored.contains_key("token"));
        ensure!(stored.get_datetime("dueAt")?.timestamp_millis() == NOW + 60_000);
        ensure!(
            !jobs.retry(&claim, &job("lost-retry"), due).await?,
            "repeating it changes nothing"
        );
        ensure!(matches!(
            jobs.claim(&job("lost-retry"), QUEUE, "owner-early").await?,
            ClaimResult::Busy { .. }
        ));
        clock.advance(60_000);
        ensure!(matches!(
            jobs.claim(&job("lost-retry"), QUEUE, "owner-due").await?,
            ClaimResult::Claimed { .. }
        ));

        // Completion: durably completed; repeating it answers false; it never runs again.
        jobs.prepare(&job("lost-complete"), QUEUE, &options())
            .await?;
        let ClaimResult::Claimed { claim, .. } = jobs
            .claim(&job("lost-complete"), QUEUE, "owner-complete")
            .await?
        else {
            return Err(anyhow!("claim"));
        };
        proxy.lose_reply_to(&[b"update\0", b"owner-complete", b"completed"]);
        let told = jobs.complete(&claim).await;
        ensure!(proxy.replies_lost() == 2);
        ensure!(told.as_ref().is_err_and(timed_out), "{told:?}");
        ensure!(intent(&store, "lost-complete").await?.get_str("status")? == "completed");
        ensure!(!jobs.complete(&claim).await?);
        ensure!(matches!(
            jobs.claim(&job("lost-complete"), QUEUE, "owner-again")
                .await?,
            ClaimResult::Terminal { .. }
        ));
        Ok(())
    })
    .await
}

fn follow(message_id: &str) -> dima_events::producers::twitch::TwitchNotification {
    let object = |json: serde_json::Value| match Value::from_json(&json) {
        Value::Object(object) => object,
        _ => Object::new(),
    };
    dima_events::producers::twitch::TwitchNotification {
        message_id: message_id.into(),
        message_timestamp: Some("2026-11-11T10:20:29.123Z".into()),
        message_retry: Some(0.0),
        stale_retry: Some(false),
        subscription: object(
            serde_json::json!({ "id": "sub", "type": "channel.follow", "version": "2", "condition": { "broadcaster_user_id": "1001" } }),
        ),
        event: Value::Object(object(
            serde_json::json!({ "broadcaster_user_id": "1001", "user_id": "7", "followed_at": "2026-11-11T10:20:29Z" }),
        )),
        source: None,
        durable_chat_handled: true,
        durable_defense_handled: true,
    }
}

#[tokio::test]
async fn lost_delivery_creation_and_marker_clearing_replies_converge() -> Result<()> {
    with_store(|store| async move {
        let Some((proxy, other)) = through(&store).await? else {
            return Ok(());
        };
        let clock = ManualClock::new(NOW);
        let events_report = support::indexes(&store, &domain_events::INFO).await?;
        let journal = Journal::new(
            store.clone(),
            Arc::new(clock.clone()),
            &EventsConfig::default(),
            &events_report,
        )?
        .with_owners(Owners::Fixed(None));
        journal.ingest_twitch(&follow("lost-1"), None).await?;
        let deliveries_report = support::indexes(&store, &domain_event_deliveries::INFO).await?;
        let deliveries = store.documents(domain_event_deliveries::COLLECTION);

        // Delivery creation: the upsert committed; the next ensure finds the same delivery.
        let stored = store
            .documents(domain_events::COLLECTION)
            .find_one(doc! {})
            .await?
            .ok_or_else(|| anyhow!("event"))?;
        let event = DispatchEvent::from_document(&stored)?;
        proxy.lose_reply_to(&[b"findAndModify\0", b"$setOnInsert", b"lost-consumer-v1"]);
        let told = ensure_delivery(&other, DEADLINE, NOW, "lost-consumer-v1", &event).await;
        ensure!(proxy.replies_lost() == 1);
        ensure!(
            matches!(&told, Err(DispatchError::Store(error @ StoreError::Timeout { .. })) if error.outcome_unknown()),
            "{told:?}"
        );
        let made = deliveries
            .find_one(doc! { "consumer": "lost-consumer-v1" })
            .await?
            .ok_or_else(|| anyhow!("the delivery was made"))?;
        ensure!(made.get_str("status")? == "pending");
        let again = ensure_delivery(&other, DEADLINE, NOW, "lost-consumer-v1", &event).await?;
        ensure!(again.get("_id") == made.get("_id"));
        ensure!(
            deliveries
                .count_documents(doc! { "consumer": "lost-consumer-v1" })
                .await?
                == 1
        );

        // Marker clearing: every delivery exists and the marker is cleared; the caller is told
        // the dispatch failed, and the next sweep finds nothing to do and makes nothing twice.
        let dispatcher = Dispatcher::new(
            other.clone(),
            Arc::new(clock.clone()),
            &EventsConfig {
                store_deadline: DEADLINE,
            },
            &CONSUMERS,
            &deliveries_report,
        )?;
        proxy.lose_reply_to(&[b"update\0", b"dispatchPending"]);
        let told = dispatcher.dispatch(100).await;
        ensure!(proxy.replies_lost() == 2);
        ensure!(
            matches!(&told, Err(DispatchError::Store(StoreError::Timeout { .. }))),
            "{told:?}"
        );
        ensure!(
            store
                .documents(domain_events::COLLECTION)
                .count_documents(doc! { "dispatchPending": true })
                .await?
                == 0
        );
        let made = deliveries.count_documents(doc! {}).await?;
        ensure!(dispatcher.dispatch(100).await?.events == 0);
        ensure!(deliveries.count_documents(doc! {}).await? == made);
        Ok(())
    })
    .await
}
