//! A receipt's retention expiry is never written from a stale tier (item 4 of P2-BILLING-02c,
//! re-check point S5). The review's interleaving: a writer (the receipt consumer, or the
//! backfill) has its tier; a plan change writes the owner's new tier and finishes its retention
//! pass; the writer then stores the receipt with the old tier's expiry, which `$setOnInsert`
//! never repairs, and the TTL later deletes history a paying channel should keep (or keeps
//! history a downgrade should drop). Each case runs the plan change at the moment the writer is
//! about to store the receipt, with a throwaway MongoDB database and Dragonfly database 9, and
//! retries a plan change that was told to wait (as the journal retries it).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod usage_support;

use anyhow::Result;
use bson::oid::ObjectId;
use bson::{Bson, doc};
use dima_billing::plans::PlanTier;
use dima_billing::plans::entitlements::EntitledPlan;
use dima_billing::plans::projection::{
    PlanOwnerState, PlanProjection, ProjectionError, ProjectionStores, project_polar_plan,
};
use dima_billing::usage::EntryKind;
use dima_billing::usage_ledger::WriteBoundary;
use dima_billing::usage_ledger::receipt::{QueuedReceipt, parse_queued_receipt};
use dima_billing::usage_ledger::record::BackfillWrite;
use dima_billing::usage_ledger::report::Transaction;
use dima_billing::usage_ledger::retention::UsageRetention;
use dima_model::StrEnum;
use dima_model::ai_usage_receipts::RetentionTier;
use futures_util::future::BoxFuture;
use std::sync::Mutex;
use usage_support::{DAY, Env, NOW, support};

const CUSTOMER: &str = "cus_race_1";

/// The channels a test used: every key containing one of them (Dragonfly database 9) is deleted
/// when the test ends, whether it passed or not.
#[derive(Default)]
struct Channels(Mutex<Vec<String>>);

impl Channels {
    fn new_channel(&self) -> String {
        let channel = support::channel_id();
        self.0.lock().unwrap().push(channel.clone());
        channel
    }
}

impl Drop for Channels {
    fn drop(&mut self) {
        let channels = std::mem::take(&mut *self.0.lock().unwrap());
        let _ = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async {
                if let Ok(Some(dragonfly)) = support::dragonfly(9).await {
                    for channel in channels {
                        support::cleanup(&dragonfly, &channel).await.unwrap();
                    }
                }
            });
        })
        .join();
    }
}

fn receipt(channel: &str, id: &str, occurred_at: i64) -> QueuedReceipt {
    let at = dima_text::to_iso_string(occurred_at).unwrap();
    let text = format!(
        r#"{{"channelID":"{channel}","customerId":"{CUSTOMER}","id":"{id}","requestId":"req-{id}","occurredAt":"{at}","entryKind":"usage","category":"tts","operation":"synthesize","source":"tts_queue","adjustmentType":null,"provider":"fish","model":null,"quantity":100,"unit":"characters","credits":10,"resourceType":"speech","resourceId":"speech-{id}","itemized":true,"enqueuedAt":"{at}"}}"#
    );
    parse_queued_receipt(text.as_bytes()).unwrap()
}

fn transaction(id: &str, at: i64) -> Transaction {
    Transaction {
        id: id.into(),
        request_id: Some(format!("req-{id}")),
        occurred_at_ms: at,
        entry_kind: EntryKind::Usage,
        category: "tts".into(),
        operation: "synthesize".into(),
        source: Some("tts_queue".into()),
        adjustment_type: None,
        provider: "fish".into(),
        model: None,
        quantity: Some(100.0),
        unit: Some(dima_billing::usage::Unit::Characters),
        credits: 10.0,
        resource_type: None,
        resource_id: None,
        itemized: true,
    }
}

async fn owner(env: &Env, channel: &str, tier: &str) -> Result<PlanOwnerState> {
    let id = ObjectId::new();
    let then = bson::DateTime::from_millis(NOW - 400 * DAY);
    env.mongo
        .documents("users")
        .insert_one(doc! {
            "_id": id, "name": "owner",
            "accounts": [{ "_id": ObjectId::new(), "type": "twitch", "id": channel, "actived": true }],
            "polar_sh_customer_id": CUSTOMER, "plan_tier": tier, "plan_tier_until": Bson::Null,
            "token_balance": 0, "created_at": then, "updated_at": then, "__v": 0,
        })
        .await?;
    let document = env
        .mongo
        .documents("users")
        .find_one(doc! {"_id": id})
        .await?
        .unwrap();
    Ok(PlanOwnerState::of(&dima_model::decode_document::<
        dima_model::users::User,
    >(&document)?))
}

type Change<'a> =
    Box<dyn Fn() -> BoxFuture<'a, Result<PlanProjection, ProjectionError>> + Send + Sync + 'a>;

/// Runs the plan change, once, when the writer reaches `point`.
struct PlanChangeAt<'a> {
    point: &'static str,
    change: Change<'a>,
    outcome: Mutex<Option<Result<PlanProjection, String>>>,
}

impl WriteBoundary for PlanChangeAt<'_> {
    fn reached<'b>(&'b self, point: &'static str) -> BoxFuture<'b, ()> {
        Box::pin(async move {
            let first = point == self.point && self.outcome.lock().unwrap().is_none();
            if first {
                let result = (self.change)().await.map_err(|e| e.to_string());
                *self.outcome.lock().unwrap() = Some(result);
            }
        })
    }
}

#[derive(Clone, Copy, Debug)]
enum Writer {
    Consumer,
    Backfill,
}

fn tier(text: &str) -> RetentionTier {
    dima_billing::usage_ledger::valid_tier(Some(text))
}

/// One race: the owner is on `from`; the writer has `from` as its tier; the plan change to `to`
/// runs at the writer's receipt write. Afterwards the receipt carries the tier that won (or is
/// gone when that tier's retention drops it), and so does its day.
async fn race(
    env: &Env,
    channels: &Channels,
    writer: Writer,
    from: &str,
    to: PlanTier,
    occurred: i64,
) -> Result<()> {
    let channel = channels.new_channel();
    let owner = owner(env, &channel, from).await?;
    let stores = ProjectionStores {
        mongo: &env.mongo,
        dragonfly: &env.dragonfly,
    };
    let retention = UsageRetention {
        ledger: env.plain(),
    };
    let plan = EntitledPlan {
        plan_tier: to,
        until_ms: None,
    };
    let change: Change<'_> = Box::new(|| {
        Box::pin(project_polar_plan(
            stores.clone(),
            &retention,
            &owner,
            plan,
            NOW - 1000,
            "change",
            CUSTOMER,
            "fp",
            NOW,
            &dima_core::SystemRandom,
        ))
    });
    let boundary = PlanChangeAt {
        point: match writer {
            Writer::Consumer => "receipt.upsert",
            Writer::Backfill => "backfill.receipts",
        },
        change,
        outcome: Mutex::new(None),
    };
    let ledger = env.ledger(&boundary);
    match writer {
        Writer::Consumer => {
            ledger
                .persist_receipt(&receipt(&channel, "aiu_race", occurred), tier(from))
                .await?;
        }
        Writer::Backfill => {
            let transactions = [transaction("aiu_race", occurred)];
            ledger
                .backfill(&BackfillWrite {
                    channel_id: &channel,
                    customer_id: CUSTOMER,
                    plan_tier: Some(from),
                    coverage_start_ms: NOW - 29 * DAY,
                    rebuild_start_ms: Some(occurred),
                    transactions: &transactions,
                    now_ms: NOW,
                })
                .await?;
        }
    }
    let first = boundary.outcome.lock().unwrap().clone();
    assert!(first.is_some(), "{writer:?}: the plan change ran");
    if first != Some(Ok(PlanProjection::Applied)) {
        // Told to wait while the writer held the owner's coordination: the journal retries.
        assert_eq!(
            (boundary.change)().await?,
            PlanProjection::Applied,
            "{writer:?} {from}->{to:?}"
        );
    }
    let receipts: Vec<bson::Document> = env
        .mongo
        .documents("ai_usage_receipts")
        .find(doc! { "channelID": &channel })
        .await?
        .try_collect()
        .await?;
    let days: Vec<bson::Document> = env
        .mongo
        .documents("ai_usage_dailies")
        .find(doc! { "channelID": &channel })
        .await?
        .try_collect()
        .await?;
    let won = tier(to.as_str());
    let kept = dima_billing::usage_ledger::retention_days(won);
    let case = format!("{writer:?} {from}->{}", to.as_str());
    if occurred + kept * DAY > NOW {
        assert_eq!(receipts.len(), 1, "{case}");
        assert_eq!(receipts[0].get_str("retentionTier")?, to.as_str(), "{case}");
        assert_eq!(
            receipts[0].get_datetime("expiresAt")?.timestamp_millis(),
            occurred + kept * DAY,
            "{case}: the expiry of the tier that won"
        );
        assert_eq!(days.len(), 1, "{case}");
        assert_eq!(days[0].get_str("retentionTier")?, to.as_str(), "{case}");
        assert!(
            days[0].get_datetime("expiresAt")?.timestamp_millis() >= occurred + kept * DAY,
            "{case}: the day outlives its receipt"
        );
    } else {
        assert!(receipts.is_empty(), "{case}: dropped by the downgrade");
        assert!(days.is_empty(), "{case}");
    }
    env.cleanup(&[&channel]).await
}

use futures_util::TryStreamExt;

/// Upgrade (the direction that matters: history must not be deleted early) and downgrade (a
/// longer expiry is harmless but converges), for the receipt consumer and for the backfill.
#[tokio::test]
async fn a_receipt_written_while_the_plan_changes_carries_the_tier_that_won() -> Result<()> {
    support::with_mongo(|store| async move {
        let env = Env::new(store).await?;
        let channels = Channels::default();
        for writer in [Writer::Consumer, Writer::Backfill] {
            race(
                &env,
                &channels,
                writer,
                "free",
                PlanTier::Premium,
                NOW - 20 * DAY,
            )
            .await?;
            race(
                &env,
                &channels,
                writer,
                "premium",
                PlanTier::Free,
                NOW - 40 * DAY,
            )
            .await?;
        }
        env.cleanup(&[]).await
    })
    .await
}

/// A writer whose tier is stale before it starts (the consumer read it for its batch, the
/// backfill job carries the tier it was queued with): the owner's current tier is written.
#[tokio::test]
async fn a_writer_with_a_stale_tier_writes_the_owner_s_current_one() -> Result<()> {
    support::with_mongo(|store| async move {
        let env = Env::new(store).await?;
        let ledger = env.plain();
        let channels = Channels::default();
        let channel = channels.new_channel();
        owner(&env, &channel, "pro").await?;
        let occurred = NOW - 50 * DAY;
        ledger
            .persist_receipt(
                &receipt(&channel, "aiu_stale", occurred),
                RetentionTier::Free,
            )
            .await?;
        let transactions = [transaction("aiu_stale_backfill", occurred)];
        ledger
            .backfill(&BackfillWrite {
                channel_id: &channel,
                customer_id: CUSTOMER,
                plan_tier: Some("free"),
                coverage_start_ms: NOW - 29 * DAY,
                rebuild_start_ms: Some(occurred),
                transactions: &transactions,
                now_ms: NOW,
            })
            .await?;
        let receipts: Vec<bson::Document> = env
            .mongo
            .documents("ai_usage_receipts")
            .find(doc! { "channelID": &channel })
            .await?
            .try_collect()
            .await?;
        assert_eq!(receipts.len(), 2, "both kept by Pro's 90 days");
        for receipt in &receipts {
            assert_eq!(receipt.get_str("retentionTier")?, "pro");
            assert_eq!(
                receipt.get_datetime("expiresAt")?.timestamp_millis(),
                occurred + 90 * DAY
            );
        }
        env.cleanup(&[&channel]).await
    })
    .await
}

/// While a plan change of the owner holds its plan effects lease, the receipt consumer leaves
/// the owner's receipts claimed (no attempt counted) and the next call records them with the
/// tier that won.
#[tokio::test]
async fn the_consumer_waits_for_a_plan_change_without_counting_an_attempt() -> Result<()> {
    use dima_billing::NoopObserver;
    use dima_billing::plans::projection::effects_lease_key;
    use dima_billing::usage_receipts::consumer::{ConsumerConfig, ReceiptConsumer};
    support::with_mongo(|store| async move {
        let mut env = Env::new(store).await?;
        env.config.plan_lease_wait = std::time::Duration::from_millis(200);
        let channels = Channels::default();
        let channel = channels.new_channel();
        let owner = owner(&env, &channel, "premium").await?;
        let keys = env.receipt_keys();
        let at = dima_text::to_iso_string(NOW - 50 * DAY).unwrap();
        for id in ["aiu_wait_1", "aiu_wait_2"] {
            let text = format!(
                r#"{{"channelID":"{channel}","customerId":"{CUSTOMER}","id":"{id}","requestId":"req-{id}","occurredAt":"{at}","entryKind":"usage","category":"tts","operation":"synthesize","source":"tts_queue","adjustmentType":null,"provider":"fish","model":null,"quantity":1,"unit":"characters","credits":3,"resourceType":null,"resourceId":null,"itemized":true,"enqueuedAt":"{at}"}}"#
            );
            env.dragonfly.rpush(&keys.queue, &[text.as_bytes()]).await?;
        }
        let config = ConsumerConfig {
            job_deadline: std::time::Duration::from_secs(60),
            tick_deadline: std::time::Duration::from_secs(120),
            ..ConsumerConfig::default()
        };
        let consumer = ReceiptConsumer {
            ledger: env.plain(),
            keys: &keys,
            config: &config,
            random: &env.random,
            observer: &NoopObserver,
        };
        // A plan change holds the owner's lease.
        let lease = effects_lease_key(&owner.id);
        env.dragonfly
            .set(
                &lease,
                b"another-plan-change",
                dima_store::dragonfly::SetOptions {
                    condition: dima_store::dragonfly::SetCondition::Always,
                    expiry: dima_store::dragonfly::SetExpiry::Millis(60_000),
                    get: false,
                },
            )
            .await?;
        let waiting = consumer.settle_batch().await?;
        assert_eq!(
            (waiting.claimed, waiting.deferred, waiting.inserted, waiting.retried),
            (2, 2, 0, 0),
            "{waiting:?}"
        );
        assert!(!waiting.ready());
        assert_eq!(env.list(&keys.processing).await?.len(), 2, "still claimed");
        assert!(env.list(&keys.dead).await?.is_empty());
        for job in env.list(&keys.processing).await? {
            assert_eq!(env.dragonfly.get_text(&keys.attempts(job.as_bytes())).await?, None);
        }
        // The plan change ends (an upgrade to Pro was written meanwhile): the next call resumes
        // both and records them with Pro's retention.
        env.mongo
            .documents("users")
            .update_one(doc! {"_id": owner.id}, doc! {"$set": {"plan_tier": "pro"}})
            .await?;
        env.dragonfly.del(&[&lease]).await?;
        let resumed = consumer.settle_batch().await?;
        assert_eq!(
            (resumed.resumed, resumed.inserted, resumed.deferred),
            (2, 2, 0),
            "{resumed:?}"
        );
        let receipts: Vec<bson::Document> = env
            .mongo
            .documents("ai_usage_receipts")
            .find(doc! { "channelID": &channel })
            .await?
            .try_collect()
            .await?;
        assert_eq!(receipts.len(), 2);
        assert!(
            receipts
                .iter()
                .all(|r| r.get_str("retentionTier").unwrap() == "pro")
        );
        env.cleanup(&[&channel]).await
    })
    .await
}
