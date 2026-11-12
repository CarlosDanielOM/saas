//! The usage ledger against a throwaway MongoDB database and Dragonfly database 9: a use is
//! recorded once whatever repeats it (a second delivery, concurrent deliveries, a stop at any
//! write followed by a retry, the backfill delivering the same entry), the reads of the usage
//! page, the dashboards, and retention by plan that runs only behind the plan guard.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod usage_support;

use anyhow::Result;
use bson::oid::ObjectId;
use bson::{Bson, doc};
use dima_billing::plans::PlanTier;
use dima_billing::plans::entitlements::EntitledPlan;
use dima_billing::plans::projection::{
    PlanOwnerState, PlanProjection, ProjectionStores, effects_lease_key, project_polar_plan,
};
use dima_billing::usage::EntryKind;
use dima_billing::usage_backfill::{BackfillConfig, BackfillQueue};
use dima_billing::usage_ledger::dashboard::DashboardInput;
use dima_billing::usage_ledger::query::{ReadInput, TransactionFilters};
use dima_billing::usage_ledger::receipt::{QueuedReceipt, parse_queued_receipt};
use dima_billing::usage_ledger::record::{BackfillWrite, Persisted};
use dima_billing::usage_ledger::report::{Transaction, WindowInput, resolve_window};
use dima_billing::usage_ledger::retention::UsageRetention;
use dima_model::ai_usage_receipts::RetentionTier;
use usage_support::{DAY, Env, Killer, NOW, ledger_state, support};

const CUSTOMER: &str = "cus_usage_1";

fn receipt(
    channel: &str,
    id: &str,
    occurred_at: i64,
    credits: f64,
    category: &str,
) -> QueuedReceipt {
    let text = format!(
        r#"{{"channelID":"{channel}","customerId":"{CUSTOMER}","id":"{id}","requestId":"req-{id}","occurredAt":"{}","entryKind":"usage","category":"{category}","operation":"synthesize","source":"tts_queue","adjustmentType":null,"provider":"fish","model":null,"quantity":100,"unit":"characters","credits":{credits},"resourceType":"speech","resourceId":"speech-{id}","itemized":true,"enqueuedAt":"{}"}}"#,
        dima_text::to_iso_string(occurred_at).unwrap(),
        dima_text::to_iso_string(occurred_at).unwrap(),
    );
    parse_queued_receipt(text.as_bytes()).unwrap()
}

#[tokio::test]
async fn recording_a_use_twice_stores_one_receipt_and_one_day() -> Result<()> {
    support::with_mongo(|store| async move {
        let env = Env::new(store).await?;
        let channel = support::channel_id();
        let ledger = env.plain();
        let first = receipt(&channel, "aiu_1", NOW - 3_600_000, 150.0, "tts");
        assert_eq!(
            ledger.persist_receipt(&first, RetentionTier::Pro).await?,
            Persisted::Inserted
        );
        let once = ledger_state(&env.mongo).await?;
        assert_eq!(
            ledger.persist_receipt(&first, RetentionTier::Pro).await?,
            Persisted::Duplicate
        );
        assert_eq!(
            ledger_state(&env.mongo).await?,
            once,
            "a repeat changes nothing"
        );
        let stored = &once[0][0];
        assert_eq!(stored.get("credits"), Some(&Bson::Int32(150)));
        assert_eq!(stored.get("quantity"), Some(&Bson::Int32(100)));
        assert_eq!(stored.get_str("retentionTier")?, "pro");
        assert_eq!(
            stored.get_datetime("expiresAt")?.timestamp_millis(),
            NOW - 3_600_000 + 90 * DAY
        );
        assert_eq!(stored.get("__v"), Some(&Bson::Int32(0)));
        let keys: Vec<&str> = stored.keys().map(String::as_str).collect();
        // MongoDB orders an upsert: the filter's fields (in an order that varies), then the new
        // ones in lexicographic order.
        let mut filter_fields = keys[..3].to_vec();
        filter_fields.sort_unstable();
        assert_eq!(filter_fields, ["channelID", "customerId", "entryId"]);
        assert_eq!(
            keys[3..],
            [
                "__v",
                "adjustmentType",
                "category",
                "created_at",
                "credits",
                "entryKind",
                "expiresAt",
                "itemized",
                "model",
                "occurredAt",
                "operation",
                "provider",
                "quantity",
                "requestId",
                "resourceId",
                "resourceType",
                "retentionTier",
                "source",
                "unit",
                "updated_at"
            ]
        );
        let day = &once[1][0];
        assert_eq!(day.get("spentCredits"), Some(&Bson::Int32(150)));
        assert_eq!(day.get("transactionCount"), Some(&Bson::Int32(1)));
        assert_eq!(
            day.keys().last().map(String::as_str),
            Some("categories"),
            "the native worker's order"
        );
        assert_eq!(
            day.get_document("categories")?
                .get_document("tts")?
                .get("credits"),
            Some(&Bson::Int32(150))
        );
        env.cleanup(&[&channel]).await
    })
    .await
}

#[tokio::test]
async fn concurrent_deliveries_of_one_receipt_store_it_once() -> Result<()> {
    support::with_mongo(|store| async move {
        let env = Env::new(store).await?;
        let channel = support::channel_id();
        let ledger = env.plain();
        let one = receipt(&channel, "aiu_race", NOW - 60_000, 42.0, "ai_chat");
        let outcomes = futures_util::future::join_all(
            (0..8).map(|_| ledger.persist_receipt(&one, RetentionTier::Free)),
        )
        .await;
        let inserted = outcomes
            .iter()
            .filter(|o| matches!(o, Ok(Persisted::Inserted)))
            .count();
        let duplicates = outcomes
            .iter()
            .filter(|o| matches!(o, Ok(Persisted::Duplicate)))
            .count();
        assert_eq!((inserted, duplicates), (1, 7), "{outcomes:?}");
        let state = ledger_state(&env.mongo).await?;
        assert_eq!(state[0].len(), 1);
        assert_eq!(state[1][0].get("transactionCount"), Some(&Bson::Int32(1)));
        env.cleanup(&[&channel]).await
    })
    .await
}

#[tokio::test]
async fn a_receipt_past_its_retention_is_not_stored() -> Result<()> {
    support::with_mongo(|store| async move {
        let env = Env::new(store).await?;
        let channel = support::channel_id();
        env.mongo
            .documents("ai_usage_dashboards")
            .insert_one(doc! {"key": "k", "channelID": &channel, "customerId": CUSTOMER, "planTier": "free", "request": {}, "data": {}, "dirty": false, "refreshedAt": bson::DateTime::from_millis(NOW), "expiresAt": bson::DateTime::from_millis(NOW + DAY)})
            .await?;
        let old = receipt(&channel, "aiu_old", NOW - 31 * DAY, 5.0, "tts");
        assert_eq!(env.plain().persist_receipt(&old, RetentionTier::Free).await?, Persisted::Expired);
        let state = ledger_state(&env.mongo).await?;
        assert!(state[0].is_empty() && state[1].is_empty());
        assert_eq!(state[3][0].get_bool("dirty")?, true, "dashboards are dirtied first");
        env.cleanup(&[&channel]).await
    })
    .await
}

/// A stop at every write of recording a use, then a retry: the ledger ends exactly as after
/// one clean recording, and no moment counts the use twice.
#[tokio::test]
async fn a_stop_at_every_write_then_a_retry_records_the_use_once() -> Result<()> {
    support::with_mongo(|store| async move {
        let env = Env::new(store).await?;
        let channel = support::channel_id();
        let earlier = receipt(&channel, "aiu_a", NOW - 7_200_000, 10.0, "tts");
        let use_ = receipt(&channel, "aiu_b", NOW - 3_600_000, 20.0, "ai_chat");
        let reset = || async {
            for name in [
                "ai_usage_receipts",
                "ai_usage_dailies",
                "ai_usage_dashboards",
            ] {
                env.mongo.documents(name).delete_many(doc! {}).await?;
            }
            env.plain()
                .persist_receipt(&earlier, RetentionTier::Premium)
                .await?;
            anyhow::Ok(())
        };
        reset().await?;
        let counter = usage_support::Counter::default();
        env.ledger(&counter)
            .persist_receipt(&use_, RetentionTier::Premium)
            .await?;
        let writes = counter.0.lock().unwrap().clone();
        assert_eq!(
            writes,
            [
                "dashboards.dirty",
                "receipt.upsert",
                "dailies.delete",
                "dailies.insert"
            ]
        );
        let clean = ledger_state(&env.mongo).await?;
        for at in 0..writes.len() {
            reset().await?;
            let killer = Killer::new(at);
            let ledger = env.ledger(&killer);
            assert!(
                killer
                    .run(ledger.persist_receipt(&use_, RetentionTier::Premium))
                    .await
            );
            let stopped = ledger_state(&env.mongo).await?;
            let counted: i32 = stopped[1]
                .iter()
                .map(|d| d.get_i32("transactionCount").unwrap())
                .sum();
            assert!(
                counted as usize <= stopped[0].len(),
                "never counted twice ({at})"
            );
            env.expire_locks(&channel, CUSTOMER).await?;
            env.plain()
                .persist_receipt(&use_, RetentionTier::Premium)
                .await?;
            assert_eq!(
                ledger_state(&env.mongo).await?,
                clean,
                "stopped before {}",
                writes[at]
            );
        }
        env.cleanup(&[&channel]).await
    })
    .await
}

fn transaction(id: &str, at: i64, credits: f64) -> Transaction {
    Transaction {
        id: id.into(),
        request_id: Some(format!("req-{id}")),
        occurred_at_ms: at,
        entry_kind: if credits < 0.0 {
            EntryKind::Adjustment
        } else {
            EntryKind::Usage
        },
        category: if credits < 0.0 {
            "credit_adjustment"
        } else {
            "tts"
        }
        .into(),
        operation: "synthesize".into(),
        source: Some("tts_queue".into()),
        adjustment_type: None,
        provider: "fish".into(),
        model: None,
        quantity: Some(100.0),
        unit: Some(dima_billing::usage::Unit::Characters),
        credits,
        resource_type: None,
        resource_id: None,
        itemized: true,
    }
}

/// The backfill delivers what the queue already delivered (same entry id): one receipt.
#[tokio::test]
async fn a_backfill_overlapping_the_queue_adds_each_receipt_once() -> Result<()> {
    support::with_mongo(|store| async move {
        let env = Env::new(store).await?;
        let channel = support::channel_id();
        let ledger = env.plain();
        ledger
            .persist_receipt(
                &receipt(&channel, "aiu_q", NOW - 3_600_000, 150.0, "tts"),
                RetentionTier::Pro,
            )
            .await?;
        let polar = [
            transaction("aiu_q", NOW - 3_600_000, 150.0),
            transaction("aiu_lost", NOW - 1_800_000, 30.0),
            transaction("polar-credit:g", NOW - 2 * DAY, -1000.0),
            transaction("too_old", NOW - 91 * DAY, 9.0),
        ];
        let write = BackfillWrite {
            channel_id: &channel,
            customer_id: CUSTOMER,
            plan_tier: Some("pro"),
            coverage_start_ms: NOW - 89 * DAY,
            rebuild_start_ms: Some(NOW - 3 * DAY),
            transactions: &polar,
            now_ms: NOW,
        };
        ledger.backfill(&write).await?;
        ledger.backfill(&write).await?;
        let state = ledger_state(&env.mongo).await?;
        let ids: Vec<&str> = state[0]
            .iter()
            .map(|d| d.get_str("entryId").unwrap())
            .collect();
        assert_eq!(ids, ["aiu_lost", "aiu_q", "polar-credit:g"]);
        let today: Vec<_> = state[1]
            .iter()
            .filter(|d| d.get_str("date").unwrap() == "2026-11-12")
            .collect();
        assert_eq!(today[0].get("transactionCount"), Some(&Bson::Int32(2)));
        assert_eq!(today[0].get("spentCredits"), Some(&Bson::Int32(180)));
        assert_eq!(state[2][0].get_i32("reportVersion")?, 3);
        let status = ledger
            .ledger_status(&channel, CUSTOMER, NOW - 30 * DAY)
            .await?;
        assert!(status.ready);
        assert_eq!(
            status.last_synced_at.as_deref(),
            Some("2026-11-12T12:00:00.000Z")
        );
        env.cleanup(&[&channel]).await
    })
    .await
}

#[tokio::test]
async fn the_usage_page_reads_status_pages_and_dashboards() -> Result<()> {
    support::with_mongo(|store| async move {
        let env = Env::new(store).await?;
        let channel = support::channel_id();
        let ledger = env.plain();
        for (i, credits) in [5.0, 7.0, 11.0].iter().enumerate() {
            ledger
                .persist_receipt(
                    &receipt(
                        &channel,
                        &format!("aiu_{i}"),
                        NOW - (i as i64 + 1) * 3_600_000,
                        *credits,
                        "tts",
                    ),
                    RetentionTier::Pro,
                )
                .await?;
        }
        let window = resolve_window(WindowInput {
            time_zone: Some("America/Mexico_City"),
            now_ms: NOW,
            max_days: Some(90.0),
            ..WindowInput::default()
        })?;
        // Pending (no backfill yet): a backfill is asked for, once.
        let keys = env.backfill_keys();
        let config = BackfillConfig::default();
        let backfills = BackfillQueue {
            dragonfly: &env.dragonfly,
            keys: &keys,
            config: &config,
            random: &env.random,
        };
        let input = ReadInput {
            channel_id: &channel,
            customer_id: CUSTOMER,
            plan_tier: Some("pro"),
            window: &window,
        };
        assert!(!ledger.usage_ledger_status(&input, &backfills).await?.ready);
        ledger.usage_ledger_status(&input, &backfills).await?;
        assert_eq!(env.list(&keys.jobs.queue).await?.len(), 1, "deduplicated");
        // Pages.
        let first = ledger
            .query_transactions(
                &channel,
                CUSTOMER,
                &window,
                &TransactionFilters {
                    limit: Some(2.0),
                    ..Default::default()
                },
            )
            .await?;
        assert_eq!(
            first
                .items
                .iter()
                .map(|i| i["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["aiu_0", "aiu_1"]
        );
        let cursor = first.next_cursor.clone().unwrap();
        let second = ledger
            .query_transactions(
                &channel,
                CUSTOMER,
                &window,
                &TransactionFilters {
                    limit: Some(2.0),
                    cursor: Some(&cursor),
                    ..Default::default()
                },
            )
            .await?;
        assert_eq!(second.items.len(), 1);
        assert_eq!(second.next_cursor, None);
        let other_scope = ledger
            .query_transactions(
                &channel,
                CUSTOMER,
                &window,
                &TransactionFilters {
                    category: Some("tts"),
                    cursor: Some(&cursor),
                    ..Default::default()
                },
            )
            .await;
        assert!(matches!(
            other_scope,
            Err(dima_billing::usage_ledger::query::QueryError::Read(_))
        ));
        for bad in [
            TransactionFilters {
                limit: Some(0.0),
                ..Default::default()
            },
            TransactionFilters {
                source: Some("a b"),
                ..Default::default()
            },
            TransactionFilters {
                entry_kind: Some("x"),
                ..Default::default()
            },
        ] {
            assert!(
                ledger
                    .query_transactions(&channel, CUSTOMER, &window, &bad)
                    .await
                    .is_err()
            );
        }
        // The dashboard: computed and stored, then served from the cache.
        let input = DashboardInput {
            channel_id: &channel,
            customer_id: CUSTOMER,
            plan_tier: "pro",
            account_created_at_ms: NOW - 400 * DAY,
            window: &window,
        };
        let computed = ledger.get_dashboard(&input).await?;
        assert!(!computed.cached);
        assert_eq!(computed.summary().unwrap()["totalSpentCredits"], 23.0);
        assert_eq!(
            computed.summary().unwrap()["period"]["timeZone"],
            "America/Mexico_City"
        );
        let cached = ledger.get_dashboard(&input).await?;
        assert!(cached.cached);
        assert_eq!(
            dima_text::to_js_json(&cached.data),
            dima_text::to_js_json(&computed.data)
        );
        // A new receipt dirties it; the refresh recomputes it.
        ledger
            .persist_receipt(
                &receipt(&channel, "aiu_9", NOW - 60_000, 100.0, "ai_chat"),
                RetentionTier::Pro,
            )
            .await?;
        assert_eq!(
            ledger
                .refresh_dashboards(&dima_billing::NoopObserver)
                .await?,
            1
        );
        let refreshed = ledger.get_dashboard(&input).await?;
        assert!(refreshed.cached);
        assert_eq!(refreshed.summary().unwrap()["totalSpentCredits"], 123.0);
        env.cleanup(&[&channel]).await
    })
    .await
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

/// A downgrade from Pro to Free shortens retention to 30 days, in batches, behind the guard;
/// an older plan write whose turn has passed deletes nothing.
#[tokio::test]
async fn retention_runs_only_behind_the_plan_guard() -> Result<()> {
    support::with_mongo(|store| async move {
        let mut env = Env::new(store).await?;
        env.config.retention_batch = 2;
        let channel = support::channel_id();
        let owner = owner(&env, &channel, "pro").await?;
        let ledger = env.plain();
        for (i, days) in [1, 10, 40, 50, 70].iter().enumerate() {
            ledger.persist_receipt(&receipt(&channel, &format!("aiu_{i}"), NOW - days * DAY, 10.0, "tts"), RetentionTier::Pro).await?;
        }
        ledger.backfill(&BackfillWrite { channel_id: &channel, customer_id: CUSTOMER, plan_tier: Some("pro"), coverage_start_ms: NOW - 89 * DAY, rebuild_start_ms: None, transactions: &[], now_ms: NOW }).await?;
        let stores = ProjectionStores { mongo: &env.mongo, dragonfly: &env.dragonfly };
        let retention = UsageRetention { ledger };
        // A stale write: a newer Premium write is already stored, so Free's effects stop.
        let stale_before = ledger_state(&env.mongo).await?;
        env.mongo.documents("users").update_one(doc! {"_id": owner.id}, doc! {"$set": {"plan_tier": "premium", "polar_plan_event_at": bson::DateTime::from_millis(NOW + 5000), "polar_plan_event_key": "newer"}}).await?;
        let stale = project_polar_plan(stores.clone(), &retention, &owner, EntitledPlan::FREE, NOW + 1000, "older", CUSTOMER, "fp", NOW, &dima_core::SystemRandom).await;
        assert!(stale.is_err() || stale.as_ref().ok() == Some(&PlanProjection::AlreadyCurrent) || stale.as_ref().ok() == Some(&PlanProjection::Superseded), "{stale:?}");
        assert_eq!(ledger_state(&env.mongo).await?[0], stale_before[0], "nothing deleted");
        // The real downgrade.
        env.mongo.documents("users").update_one(doc! {"_id": owner.id}, doc! {"$set": {"plan_tier": "pro"}, "$unset": {"polar_plan_event_at": "", "polar_plan_event_key": ""}}).await?;
        let applied = project_polar_plan(stores.clone(), &retention, &owner, EntitledPlan::FREE, NOW + 2000, "downgrade", CUSTOMER, "fp2", NOW, &dima_core::SystemRandom).await?;
        assert_eq!(applied, PlanProjection::Applied);
        let after = ledger_state(&env.mongo).await?;
        let ids: Vec<&str> = after[0].iter().map(|d| d.get_str("entryId").unwrap()).collect();
        assert_eq!(ids, ["aiu_0", "aiu_1"], "older than 30 days deleted");
        for receipt in &after[0] {
            assert_eq!(receipt.get_str("retentionTier")?, "free");
            let occurred = receipt.get_datetime("occurredAt")?.timestamp_millis();
            assert_eq!(receipt.get_datetime("expiresAt")?.timestamp_millis(), occurred + 30 * DAY);
        }
        assert!(after[1].iter().all(|d| d.get_str("retentionTier").unwrap() == "free"));
        assert!(after[1].iter().all(|d| d.get_datetime("expiresAt").unwrap().timestamp_millis() > NOW));
        assert_eq!(after[2][0].get_datetime("coverageStart")?.timestamp_millis(), NOW - 30 * DAY, "coverage raised");
        assert!(env.dragonfly.get_text(&effects_lease_key(&owner.id)).await?.is_none());
        let _ = PlanTier::Free;
        env.cleanup(&[&channel]).await
    })
    .await
}

/// The plan effects lease passes to another plan change between two retention batches: the
/// next confirmation refuses, and nothing more is changed or deleted.
#[tokio::test]
async fn retention_stops_at_the_first_refused_confirmation() -> Result<()> {
    support::with_mongo(|store| async move {
        let mut env = Env::new(store).await?;
        env.config.retention_batch = 2;
        let channel = support::channel_id();
        let owner = owner(&env, &channel, "pro").await?;
        for (i, days) in [1, 10, 40, 50, 70].iter().enumerate() {
            env.plain()
                .persist_receipt(
                    &receipt(&channel, &format!("aiu_{i}"), NOW - days * DAY, 10.0, "tts"),
                    RetentionTier::Pro,
                )
                .await?;
        }
        let before = ledger_state(&env.mongo).await?;
        /// Takes the owner's plan effects lease away when the first receipt batch is updated.
        struct Thief<'a> {
            dragonfly: &'a dima_store::dragonfly::Dragonfly,
            key: String,
            updates: std::sync::Mutex<usize>,
        }
        impl dima_billing::usage_ledger::WriteBoundary for Thief<'_> {
            fn reached<'a>(
                &'a self,
                point: &'static str,
            ) -> futures_util::future::BoxFuture<'a, ()> {
                Box::pin(async move {
                    if point == "retention.update" {
                        let second = {
                            let mut updates = self.updates.lock().unwrap();
                            *updates += 1;
                            *updates == 2
                        };
                        if second {
                            self.dragonfly.del(&[&self.key]).await.unwrap();
                        }
                    }
                })
            }
        }
        let thief = Thief {
            dragonfly: &env.dragonfly,
            key: effects_lease_key(&owner.id),
            updates: std::sync::Mutex::new(0),
        };
        let retention = UsageRetention {
            ledger: env.ledger(&thief),
        };
        let stores = ProjectionStores {
            mongo: &env.mongo,
            dragonfly: &env.dragonfly,
        };
        let outcome = project_polar_plan(
            stores,
            &retention,
            &owner,
            EntitledPlan::FREE,
            NOW + 1000,
            "downgrade",
            CUSTOMER,
            "fp",
            NOW,
            &dima_core::SystemRandom,
        )
        .await?;
        assert_eq!(outcome, PlanProjection::Superseded);
        let after = ledger_state(&env.mongo).await?;
        assert_eq!(after[0].len(), before[0].len(), "no receipt deleted");
        // The lease was taken after the second batch's confirmation: that batch completes (the
        // gap the guard documents), the third confirmation refuses, nothing after it runs.
        let changed = after[0]
            .iter()
            .filter(|d| d.get_str("retentionTier").unwrap() == "free")
            .count();
        assert_eq!(changed, 4, "two batches of two, then the refusal");
        assert!(
            after[1]
                .iter()
                .all(|d| d.get_str("retentionTier").unwrap() == "pro"),
            "days untouched"
        );
        env.cleanup(&[&channel]).await
    })
    .await
}
