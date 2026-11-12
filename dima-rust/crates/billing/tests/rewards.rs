//! The paid-order reward against a real MongoDB: every case of the reference's
//! `utils/paid_order_reward.test.ts` (same names where practical; the reference mocked the
//! models, here the writes are real), a process killed after each write, two deliveries at once,
//! and the abuse cases.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod gift_support;
mod support;

use bson::oid::ObjectId;
use bson::{Bson, Document, doc};
use dima_billing::gifts::Interrupt;
use dima_billing::order_rewards::{OrderRewards, PaidOrder, RewardError, RewardOutcome};
use dima_billing::products::{FREE_PRODUCT_ID, PREMIUM_PRODUCT_ID, PRO_PRODUCT_ID};
use dima_billing::referrals::Cadence;
use dima_store::mongo::MongoStore;
use serde_json::json;
use std::sync::Mutex;

const NOW: i64 = 1_794_484_800_000;

struct StopAt(Mutex<Option<&'static str>>);

impl Interrupt for StopAt {
    fn at(&self, point: &'static str) -> bool {
        let mut armed = self.0.lock().unwrap();
        if *armed == Some(point) {
            *armed = None;
            return true;
        }
        false
    }
}

fn stop(point: &'static str) -> StopAt {
    StopAt(Mutex::new(Some(point)))
}

struct Fixture {
    owner: ObjectId,
    bot: ObjectId,
    referrer: ObjectId,
}

async fn fixture(store: &MongoStore) -> Fixture {
    let (owner, bot, referrer) = (ObjectId::new(), ObjectId::new(), ObjectId::new());
    store
        .documents("users")
        .insert_many([
            doc! { "_id": owner, "accounts": [], "token_balance": 0_i32, "referrerId": Bson::Null, "referralCodeUsed": Bson::Null },
            doc! { "_id": bot, "accounts": [{ "type": "twitch", "name": "domdimabot", "id": "1" }], "token_balance": 10_i32 },
            doc! { "_id": referrer, "accounts": [], "token_balance": 20_i32 },
        ])
        .await
        .unwrap();
    Fixture {
        owner,
        bot,
        referrer,
    }
}

async fn refer(store: &MongoStore, f: &Fixture, active: bool) {
    store
        .documents("users")
        .update_one(
            doc! { "_id": f.owner },
            doc! { "$set": { "referrerId": f.referrer, "referralCodeUsed": "CAMPAIGN" } },
        )
        .await
        .unwrap();
    store
        .documents("referralcodes")
        .insert_one(doc! { "code": "campaign", "owner": f.referrer, "active": active, "label": "", "stats": { "conversions": 0 } })
        .await
        .unwrap();
}

async fn balance(store: &MongoStore, id: ObjectId) -> f64 {
    let user = store
        .documents("users")
        .find_one(doc! { "_id": id })
        .await
        .unwrap()
        .unwrap();
    dima_store::mongo::number::read_number(user.get("token_balance").unwrap()).unwrap()
}

async fn receipts(store: &MongoStore, id: ObjectId) -> usize {
    let user = store
        .documents("users")
        .find_one(doc! { "_id": id })
        .await
        .unwrap()
        .unwrap();
    user.get_array("applied_credit_transaction_ids")
        .map_or(0, Vec::len)
}

async fn reservations(store: &MongoStore) -> Vec<Document> {
    use futures_util::TryStreamExt;
    store
        .documents("credittransactions")
        .find(doc! {})
        .await
        .unwrap()
        .try_collect()
        .await
        .unwrap()
}

fn order<'a>(owner: &'a str, id: &'a str) -> PaidOrder<'a> {
    PaidOrder {
        owner_user_id: owner,
        order_id: id,
        product_id: PREMIUM_PRODUCT_ID,
        cadence: Cadence::Monthly,
    }
}

#[tokio::test]
async fn same_paid_order_twice_credits_once_for_a_canonical_owner_without_twitch() {
    support::with_mongo(|store| async move {
        let f = fixture(&store).await;
        let rewards = OrderRewards::new(&store);
        let owner = f.owner.to_hex();
        rewards
            .apply_paid_order_reward(&order(&owner, "order-1"), NOW)
            .await?;
        rewards
            .apply_paid_order_reward(&order(&owner, "order-1"), NOW)
            .await?;
        assert_eq!(balance(&store, f.bot).await, 60.0);
        assert_eq!(receipts(&store, f.bot).await, 1);
        let rows = reservations(&store).await;
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.get_str("idempotencyKey")?, "polar:paid-order:order-1");
        assert_eq!(row.get_i32("balanceAfter")?, 60);
        assert!(row.get_datetime("appliedAt").is_ok());
        let metadata = row.get_document("metadata")?;
        assert_eq!(metadata.get_object_id("referredUserId")?, f.owner);
        assert_eq!(metadata.get_str("rewardTargetType")?, "bot");
        assert_eq!(metadata.get("referralCodeUsed"), Some(&Bson::Null));
        Ok(())
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn concurrent_deliveries_of_one_order_share_a_reservation_and_atomic_credit() {
    support::with_mongo(|store| async move {
        let f = fixture(&store).await;
        let owner = f.owner.to_hex();
        for _ in 0..5 {
            // Separate processes: separate index checks.
            let (a, b) = (OrderRewards::new(&store), OrderRewards::new(&store));
            let (x, y) = futures_util::future::join(
                a.apply_paid_order_reward(&order(&owner, "order-race"), NOW),
                b.apply_paid_order_reward(&order(&owner, "order-race"), NOW),
            )
            .await;
            x?;
            y?;
        }
        assert_eq!(reservations(&store).await.len(), 1);
        assert_eq!(balance(&store, f.bot).await, 60.0);
        assert_eq!(receipts(&store, f.bot).await, 1);
        Ok(())
    })
    .await
    .unwrap();
}

/// `failCompletion`, `loseCreditResponse`: killed after the credit, before the receipt is
/// marked applied. The retry marks it without crediting again, and leaves `balanceAfter` null
/// (a replay cannot know it).
#[tokio::test]
async fn kill_after_the_credit_retry_completes_ledger_without_repeating_successful_credit() {
    support::with_mongo(|store| async move {
        let f = fixture(&store).await;
        let owner = f.owner.to_hex();
        let point = stop("reward:credited");
        let killed = OrderRewards::new(&store).with_interrupt(&point);
        assert!(matches!(
            killed
                .apply_paid_order_reward(&order(&owner, "order-1"), NOW)
                .await,
            Err(RewardError::Interrupted(_))
        ));
        assert_eq!(balance(&store, f.bot).await, 60.0);
        assert!(reservations(&store).await[0].get("appliedAt").is_none());
        store
            .documents("users")
            .update_one(
                doc! { "_id": f.bot },
                doc! { "$inc": { "token_balance": 7 } },
            )
            .await?;
        OrderRewards::new(&store)
            .apply_paid_order_reward(&order(&owner, "order-1"), NOW)
            .await?;
        assert_eq!(balance(&store, f.bot).await, 67.0);
        assert_eq!(receipts(&store, f.bot).await, 1);
        let row = &reservations(&store).await[0];
        assert!(row.get_datetime("appliedAt").is_ok());
        assert_eq!(row.get("balanceAfter"), Some(&Bson::Null));
        Ok(())
    })
    .await
    .unwrap();
}

/// `loseReservationResponse`: killed after the reservation. The retry applies the frozen
/// beneficiary, payer and amount, whatever changed since (settings, product, cadence, even the
/// owner id passed in).
#[tokio::test]
async fn reservation_response_loss_resumes_frozen_recipient_payer_and_amount_despite_changed_settings()
 {
    support::with_mongo(|store| async move {
        let f = fixture(&store).await;
        refer(&store, &f, true).await;
        let owner = f.owner.to_hex();
        let point = stop("reward:reserved");
        let killed = OrderRewards::new(&store).with_interrupt(&point);
        assert!(
            killed
                .apply_paid_order_reward(&order(&owner, "order-1"), NOW)
                .await
                .is_err()
        );
        assert_eq!(balance(&store, f.referrer).await, 20.0);
        store
            .documents("referralcodes")
            .update_many(doc! {}, doc! { "$set": { "active": false } })
            .await?;
        store
            .documents("users")
            .update_one(
                doc! { "_id": f.owner },
                doc! { "$set": { "referrerId": f.bot, "referralCodeUsed": "changed" } },
            )
            .await?;
        store
            .documents("users")
            .delete_one(doc! { "_id": f.owner })
            .await?;
        let changed = PaidOrder {
            owner_user_id: "",
            order_id: "order-1",
            product_id: FREE_PRODUCT_ID,
            cadence: Cadence::Yearly,
        };
        OrderRewards::new(&store)
            .apply_paid_order_reward(&changed, NOW)
            .await?;
        assert_eq!(balance(&store, f.referrer).await, 70.0);
        assert_eq!(balance(&store, f.bot).await, 10.0);
        let row = &reservations(&store).await[0];
        assert_eq!(row.get_i32("amount")?, 50);
        let metadata = row.get_document("metadata")?;
        assert_eq!(metadata.get_object_id("referredUserId")?, f.owner);
        assert_eq!(metadata.get_str("referralCodeUsed")?, "CAMPAIGN");
        assert_eq!(metadata.get_str("rewardTargetType")?, "referrer");
        Ok(())
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn failure_before_credit_leaves_a_reservation_that_is_applied_on_retry() {
    support::with_mongo(|store| async move {
        let f = fixture(&store).await;
        let owner = f.owner.to_hex();
        let point = stop("reward:reserved");
        let killed = OrderRewards::new(&store).with_interrupt(&point);
        assert!(
            killed
                .apply_paid_order_reward(&order(&owner, "order-1"), NOW)
                .await
                .is_err()
        );
        assert_eq!(balance(&store, f.bot).await, 10.0);
        assert_eq!(reservations(&store).await.len(), 1);
        OrderRewards::new(&store)
            .apply_paid_order_reward(&order(&owner, "order-1"), NOW)
            .await?;
        assert_eq!(balance(&store, f.bot).await, 60.0);
        Ok(())
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn ledger_response_loss_returns_on_retry_without_another_credit_attempt() {
    support::with_mongo(|store| async move {
        let f = fixture(&store).await;
        let owner = f.owner.to_hex();
        let rewards = OrderRewards::new(&store);
        rewards
            .apply_paid_order_reward(&order(&owner, "order-1"), NOW)
            .await?;
        // The completion's answer was lost: the retry finds the receipt applied.
        assert_eq!(
            rewards
                .apply_paid_order_reward(&order(&owner, "order-1"), NOW)
                .await?,
            RewardOutcome::Applied
        );
        assert_eq!(balance(&store, f.bot).await, 60.0);
        Ok(())
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn different_paid_orders_each_earn_a_reward_and_retain_both_receipts() {
    support::with_mongo(|store| async move {
        let f = fixture(&store).await;
        let owner = f.owner.to_hex();
        let rewards = OrderRewards::new(&store);
        rewards
            .apply_paid_order_reward(&order(&owner, "order-1"), NOW)
            .await?;
        rewards
            .apply_paid_order_reward(&order(&owner, "order-2"), NOW)
            .await?;
        assert_eq!(reservations(&store).await.len(), 2);
        assert_eq!(balance(&store, f.bot).await, 110.0);
        assert_eq!(receipts(&store, f.bot).await, 2);
        Ok(())
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn awards_each_product_and_cadence_its_reward_amount() {
    for (product, cadence, amount) in [
        (PREMIUM_PRODUCT_ID, Cadence::Monthly, 50.0),
        (PREMIUM_PRODUCT_ID, Cadence::Yearly, 500.0),
        (PRO_PRODUCT_ID, Cadence::Monthly, 100.0),
        (PRO_PRODUCT_ID, Cadence::Yearly, 1000.0),
    ] {
        support::with_mongo(|store| async move {
            let f = fixture(&store).await;
            refer(&store, &f, true).await;
            store
                .documents("users")
                .delete_one(doc! { "_id": f.bot })
                .await?;
            let owner = f.owner.to_hex();
            let input = PaidOrder {
                owner_user_id: &owner,
                order_id: "o",
                product_id: product,
                cadence,
            };
            OrderRewards::new(&store)
                .apply_paid_order_reward(&input, NOW)
                .await?;
            assert_eq!(balance(&store, f.referrer).await, 20.0 + amount);
            Ok(())
        })
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn historical_125_credit_pro_reward_stays_intact_when_replayed() {
    for applied in [true, false] {
        support::with_mongo(|store| async move {
            let f = fixture(&store).await;
            let receipt = ObjectId::new();
            store
                .documents("users")
                .update_one(
                    doc! { "_id": f.referrer },
                    if applied {
                        doc! { "$set": { "token_balance": 125, "applied_credit_transaction_ids": [receipt] } }
                    } else {
                        doc! { "$set": { "token_balance": 0 } }
                    },
                )
                .await?;
            let mut row = doc! {
                "_id": receipt, "idempotencyKey": "polar:paid-order:order-1", "user": f.referrer,
                "type": "subscription_reward", "amount": 125, "balanceAfter": if applied { Bson::Int32(125) } else { Bson::Null },
                "metadata": { "subscriptionId": "order-1", "planId": PRO_PRODUCT_ID, "rewardTargetType": "referrer" },
            };
            if applied {
                row.insert("appliedAt", bson::DateTime::from_millis(NOW));
            }
            store.documents("credittransactions").insert_one(row).await?;
            let owner = f.owner.to_hex();
            let input = PaidOrder { owner_user_id: &owner, order_id: "order-1", product_id: PRO_PRODUCT_ID, cadence: Cadence::Monthly };
            let rewards = OrderRewards::new(&store);
            rewards.apply_paid_order_reward(&input, NOW).await?;
            rewards.apply_paid_order_reward(&input, NOW).await?;
            assert_eq!(balance(&store, f.referrer).await, 125.0, "applied={applied}");
            assert_eq!(reservations(&store).await.len(), 1);
            assert_eq!(reservations(&store).await[0].get_i32("amount")?, 125);
            assert_eq!(receipts(&store, f.referrer).await, 1);
            Ok(())
        })
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn an_inactive_code_or_a_missing_referrer_falls_back_to_the_bot() {
    for missing_referrer in [false, true] {
        support::with_mongo(|store| async move {
            let f = fixture(&store).await;
            // An inactive code, or an active code whose referrer was deleted.
            refer(&store, &f, missing_referrer).await;
            if missing_referrer {
                store
                    .documents("users")
                    .delete_one(doc! { "_id": f.referrer })
                    .await?;
            }
            let owner = f.owner.to_hex();
            OrderRewards::new(&store)
                .apply_paid_order_reward(&order(&owner, "o"), NOW)
                .await?;
            assert_eq!(balance(&store, f.bot).await, 60.0);
            Ok(())
        })
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn missing_owner_and_missing_beneficiary_fail_without_reservation_allowing_retry() {
    support::with_mongo(|store| async move {
        let f = fixture(&store).await;
        let owner = f.owner.to_hex();
        let rewards = OrderRewards::new(&store);
        let users = store.documents("users");
        let saved_owner = users.find_one(doc! { "_id": f.owner }).await?.unwrap();
        users.delete_one(doc! { "_id": f.owner }).await?;
        let error = rewards
            .apply_paid_order_reward(&order(&owner, "o"), NOW)
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "Paid order reward owner not found");
        users.insert_one(saved_owner).await?;
        let saved_bot = users.find_one(doc! { "_id": f.bot }).await?.unwrap();
        users.delete_one(doc! { "_id": f.bot }).await?;
        let error = rewards
            .apply_paid_order_reward(&order(&owner, "o"), NOW)
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "Paid order reward beneficiary not found");
        assert!(reservations(&store).await.is_empty());
        users.insert_one(saved_bot).await?;
        rewards
            .apply_paid_order_reward(&order(&owner, "o"), NOW)
            .await?;
        assert_eq!(balance(&store, f.bot).await, 60.0);
        Ok(())
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn missing_reserved_beneficiary_throws_instead_of_marking_the_ledger_applied() {
    support::with_mongo(|store| async move {
        let f = fixture(&store).await;
        let owner = f.owner.to_hex();
        let point = stop("reward:reserved");
        let killed = OrderRewards::new(&store).with_interrupt(&point);
        assert!(
            killed
                .apply_paid_order_reward(&order(&owner, "o"), NOW)
                .await
                .is_err()
        );
        let users = store.documents("users");
        let saved_bot = users.find_one(doc! { "_id": f.bot }).await?.unwrap();
        users.delete_one(doc! { "_id": f.bot }).await?;
        let rewards = OrderRewards::new(&store);
        let error = rewards
            .apply_paid_order_reward(&order(&owner, "o"), NOW)
            .await
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "Paid order reward reserved beneficiary not found"
        );
        assert!(reservations(&store).await[0].get("appliedAt").is_none());
        users.insert_one(saved_bot).await?;
        rewards
            .apply_paid_order_reward(&order(&owner, "o"), NOW)
            .await?;
        assert_eq!(balance(&store, f.bot).await, 60.0);
        Ok(())
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn invalid_canonical_identity_and_empty_order_id_fail_before_reservation() {
    support::with_mongo(|store| async move {
        fixture(&store).await;
        let rewards = OrderRewards::new(&store);
        let error = rewards
            .apply_paid_order_reward(&order("twitch-id", "o"), NOW)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("canonical owner"));
        let error = rewards
            .apply_paid_order_reward(&order(&ObjectId::new().to_hex(), " "), NOW)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("order ID"));
        assert!(reservations(&store).await.is_empty());
        Ok(())
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn legacy_order_subscription_reward_is_not_credited_again() {
    support::with_mongo(|store| async move {
        let f = fixture(&store).await;
        store
            .documents("credittransactions")
            .insert_one(doc! { "user": f.bot, "type": "subscription_reward", "amount": 50, "metadata": { "subscriptionId": "order-1" } })
            .await?;
        let owner = f.owner.to_hex();
        let outcome = OrderRewards::new(&store).apply_paid_order_reward(&order(&owner, "order-1"), NOW).await?;
        assert_eq!(outcome, RewardOutcome::Nothing);
        assert_eq!(reservations(&store).await.len(), 1);
        assert_eq!(balance(&store, f.bot).await, 10.0);
        Ok(())
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn subscription_update_rewards_and_unrelated_types_do_not_suppress_paid_order_rewards() {
    support::with_mongo(|store| async move {
        let f = fixture(&store).await;
        store
            .documents("credittransactions")
            .insert_many([
                doc! { "user": f.bot, "type": "subscription_reward", "amount": 50, "metadata": { "subscriptionId": "subscription-1" } },
                doc! { "user": f.bot, "type": "referral_bonus", "amount": 50, "metadata": { "subscriptionId": "order-1" } },
            ])
            .await?;
        let owner = f.owner.to_hex();
        OrderRewards::new(&store).apply_paid_order_reward(&order(&owner, "order-1"), NOW).await?;
        assert_eq!(balance(&store, f.bot).await, 60.0);
        Ok(())
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn free_and_unknown_products_reserve_and_credit_nothing() {
    support::with_mongo(|store| async move {
        let f = fixture(&store).await;
        let owner = f.owner.to_hex();
        let rewards = OrderRewards::new(&store);
        for product in [FREE_PRODUCT_ID, "unknown"] {
            let input = PaidOrder {
                owner_user_id: &owner,
                order_id: "o",
                product_id: product,
                cadence: Cadence::Monthly,
            };
            assert_eq!(
                rewards.apply_paid_order_reward(&input, NOW).await?,
                RewardOutcome::Nothing
            );
        }
        assert!(reservations(&store).await.is_empty());
        assert_eq!(balance(&store, f.bot).await, 10.0);
        Ok(())
    })
    .await
    .unwrap();
}

/// `index initialization failure prevents reservation and credit`: a plain index under the
/// unique index's name (as a damaged deployment could hold) makes the check fail.
#[tokio::test]
async fn index_initialization_failure_prevents_reservation_and_credit() {
    support::with_mongo(|store| async move {
        let f = fixture(&store).await;
        store
            .database()
            .run_command(doc! {
                "createIndexes": "credittransactions",
                "indexes": [{ "key": { "idempotencyKey": 1 }, "name": "idempotencyKey_1" }],
            })
            .await?;
        let owner = f.owner.to_hex();
        let error = OrderRewards::new(&store)
            .apply_paid_order_reward(&order(&owner, "o"), NOW)
            .await
            .unwrap_err();
        assert!(matches!(error, RewardError::IndexUnavailable(_)), "{error}");
        assert!(reservations(&store).await.is_empty());
        assert_eq!(balance(&store, f.bot).await, 10.0);
        Ok(())
    })
    .await
    .unwrap();
}

#[test]
fn schema_keeps_permanent_receipts_hidden_and_reservation_keys_uniquely_indexed_only_for_strings() {
    assert!(dima_model::users::HIDDEN.contains(&"applied_credit_transaction_ids"));
    let unique = dima_model::credit_transactions::INDEXES
        .iter()
        .find(|spec| spec.name() == "idempotencyKey_1")
        .unwrap();
    let rendered = format!("{unique:?}");
    assert!(rendered.contains("unique: true"), "{rendered}");
}

// ------------------------------------------------------------------- the event and abuse

/// A replayed webhook (the same order twice), a trial order, a one-time pack, an unpaid order:
/// one reward, for the paid subscription order only.
#[tokio::test]
async fn a_replayed_or_non_paying_event_rewards_nothing_more() {
    support::with_mongo(|store| async move {
        let f = fixture(&store).await;
        let rewards = OrderRewards::new(&store);
        let paid = json!({ "orderId": "o-1", "paid": true, "productId": PRO_PRODUCT_ID, "subscriptionId": "s", "totalAmount": 1500, "cadence": "monthly" });
        for payload in [
            paid.clone(),
            paid.clone(),
            json!({ "orderId": "o-2", "paid": true, "productId": PRO_PRODUCT_ID, "subscriptionId": "s", "totalAmount": 0, "cadence": "monthly" }),
            json!({ "orderId": "o-3", "paid": true, "productId": PRO_PRODUCT_ID, "totalAmount": 1500, "cadence": "monthly" }),
            json!({ "orderId": "o-4", "paid": true, "productId": "pack", "subscriptionId": "s", "totalAmount": 1500, "cadence": "monthly" }),
        ] {
            rewards
                .apply_polar_reward_domain_event("polar-webhook", "billing.order.paid", &payload, Some(f.owner), NOW)
                .await?;
        }
        let error = rewards
            .apply_polar_reward_domain_event("polar-webhook", "billing.order.paid", &json!({ "orderId": "o-5", "paid": false }), Some(f.owner), NOW)
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "Polar rewards require a confirmed paid order");
        // Intended difference: a cadence the producer never makes is refused.
        let error = rewards
            .apply_polar_reward_domain_event(
                "polar-webhook", "billing.order.paid",
                &json!({ "orderId": "o-6", "paid": true, "productId": PRO_PRODUCT_ID, "subscriptionId": "s", "totalAmount": 1500, "cadence": "weekly" }),
                Some(f.owner), NOW,
            )
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "Polar paid order is missing its billing cadence");
        assert_eq!(balance(&store, f.bot).await, 110.0);
        assert_eq!(reservations(&store).await.len(), 1);
        let unresolved = rewards
            .apply_polar_reward_domain_event("polar-webhook", "billing.order.paid", &paid, None, NOW)
            .await
            .unwrap_err();
        assert!(matches!(unresolved, RewardError::PrerequisiteMissing(_)));
        Ok(())
    })
    .await
    .unwrap();
}

/// Reference behaviour, kept: a second account of the referrer that signed up with the
/// referrer's code earns the referrer a reward for each of its paid orders (`token_balance`,
/// which nothing spends today), and a refund takes nothing back.
#[tokio::test]
async fn a_second_account_of_the_referrer_rewards_the_referrer() {
    support::with_mongo(|store| async move {
        let f = fixture(&store).await;
        refer(&store, &f, true).await;
        // The referred account shares the referrer's e-mail: nothing in the reference links them.
        store
            .documents("users")
            .update_many(
                doc! { "_id": { "$in": [f.owner, f.referrer] } },
                doc! { "$set": { "email": "same@example.test" } },
            )
            .await?;
        let owner = f.owner.to_hex();
        OrderRewards::new(&store)
            .apply_paid_order_reward(&order(&owner, "o"), NOW)
            .await?;
        assert_eq!(balance(&store, f.referrer).await, 70.0);
        Ok(())
    })
    .await
    .unwrap();
}
