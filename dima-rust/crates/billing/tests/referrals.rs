//! Referrals against a real MongoDB: the reference's `utils/referral_stats.test.ts`, races on
//! codes and on the attribution, the abuse cases, and text (emoji, combining marks,
//! right-to-left) in labels and codes. Also the Polar account cancellation against the
//! stateful mock (lost answers, a subscription that stays billable, a list past its bound).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod gift_support;
mod support;

use bson::oid::ObjectId;
use bson::{Bson, doc};
use dima_billing::account_cancellation::{
    CancellationError, revoke_polar_subscriptions_for_account,
};
use dima_billing::referrals::{
    apply_referral_code, create_campaign_code, get_referral_stats, get_user_codes,
};
use dima_http::testing::MockServer;
use dima_store::mongo::MongoStore;
use gift_support::{Fault, World};
use serde_json::json;

const NOW: i64 = 1_794_484_800_000;

async fn user(store: &MongoStore, plan: &str) -> ObjectId {
    let id = ObjectId::new();
    store
        .documents("users")
        .insert_one(doc! {
            "_id": id, "name": "u", "plan_tier": plan, "accounts": [], "token_balance": 100_i32,
            "referrerId": Bson::Null, "referralCodeUsed": Bson::Null,
            "created_at": bson::DateTime::from_millis(NOW),
        })
        .await
        .unwrap();
    id
}

async fn unique_code_index(store: &MongoStore) {
    let report = dima_model::ensure_indexes(
        store,
        &dima_model::referral_codes::INFO,
        dima_model::IndexPolicy::RequireAll,
        std::time::Duration::from_secs(30),
    )
    .await;
    report.require().unwrap();
}

/// `referral stats separate attributed signups from one paid conversion per referred account`.
#[tokio::test]
async fn referral_stats_separate_attributed_signups_from_one_paid_conversion_per_referred_account()
{
    support::with_mongo(|store| async move {
        let owner = user(&store, "free").await;
        create_campaign_code(&store, owner, "ryutsuuki", "", NOW).await?;
        let (a, b) = (ObjectId::new(), ObjectId::new());
        for id in [a, b] {
            store
                .documents("users")
                .insert_one(doc! { "_id": id, "referrerId": owner, "referralCodeUsed": "ryutsuuki" })
                .await?;
        }
        // Two renewals of the same referred account: one conversion, both earned.
        for (n, applied) in [(1, true), (2, true)] {
            let mut row = doc! {
                "user": owner, "type": "subscription_reward", "amount": 50,
                "idempotencyKey": format!("polar:paid-order:{n}"),
                "metadata": { "referralCodeUsed": "ryutsuuki", "referredUserId": a, "rewardTargetType": "referrer" },
            };
            if applied {
                row.insert("appliedAt", bson::DateTime::from_millis(NOW));
            }
            store.documents("credittransactions").insert_one(row).await?;
        }
        let stats = get_referral_stats(&store, owner).await?;
        assert_eq!(stats["totalSignups"], json!(2));
        assert_eq!(stats["totalConversions"], json!(1));
        assert_eq!(stats["totalEarned"], json!(100));
        assert_eq!(stats["codes"][0]["stats"]["signups"], json!(2));
        assert_eq!(stats["codes"][0]["stats"]["conversions"], json!(1));
        assert_eq!(stats["currentBalance"], json!(100));
        Ok(())
    })
    .await
    .unwrap();
}

/// Intended difference: creations racing past the plan's limit never leave more codes than it
/// allows (the reference counted, then inserted).
#[tokio::test]
async fn creations_racing_past_the_limit_never_leave_more_codes_than_the_plan_allows() {
    support::with_mongo(|store| async move {
        unique_code_index(&store).await;
        let owner = user(&store, "premium").await;
        let codes: Vec<String> = (0..12).map(|n| format!("race{n}")).collect();
        let results = futures_util::future::join_all(
            codes
                .iter()
                .map(|code| create_campaign_code(&store, owner, code, "", NOW)),
        )
        .await;
        for result in &results {
            if let Err(error) = result {
                assert!(
                    error.to_string().starts_with("Referral code limit reached"),
                    "{error}"
                );
            }
        }
        let left = get_user_codes(&store, owner).await?.len();
        assert!(left <= 5, "{left} codes for a limit of 5");
        assert!(results.iter().filter(|r| r.is_ok()).count() <= 5);
        Ok(())
    })
    .await
    .unwrap();
}

/// Intended difference: the same code created twice at once is one code; the other caller is
/// told it is taken (the reference let the duplicate-key error through as a 500).
#[tokio::test]
async fn the_same_code_created_twice_at_once_is_taken_once() {
    support::with_mongo(|store| async move {
        unique_code_index(&store).await;
        let (a, b) = (user(&store, "pro").await, user(&store, "pro").await);
        let (x, y) = futures_util::future::join(
            create_campaign_code(&store, a, "Shared", "", NOW),
            create_campaign_code(&store, b, "shared", "", NOW),
        )
        .await;
        assert_eq!(usize::from(x.is_ok()) + usize::from(y.is_ok()), 1);
        for error in [x.err(), y.err()].into_iter().flatten() {
            assert_eq!(error.to_string(), "This referral code is already taken.");
        }
        Ok(())
    })
    .await
    .unwrap();
}

/// A new account can be attributed once: two codes applied at the same moment, one wins; the
/// owner's own code and a second code are refused.
#[tokio::test]
async fn an_account_is_attributed_once_and_never_to_itself() {
    support::with_mongo(|store| async move {
        let (r1, r2, newcomer) = (
            user(&store, "pro").await,
            user(&store, "pro").await,
            user(&store, "free").await,
        );
        create_campaign_code(&store, r1, "first", "", NOW).await?;
        create_campaign_code(&store, r2, "second", "", NOW).await?;
        create_campaign_code(&store, newcomer, "mine", "", NOW).await?;
        assert!(!apply_referral_code(&store, newcomer, "mine", NOW).await?);
        let (x, y) = futures_util::future::join(
            apply_referral_code(&store, newcomer, "FIRST", NOW),
            apply_referral_code(&store, newcomer, "second", NOW),
        )
        .await;
        assert_eq!(usize::from(x?) + usize::from(y?), 1);
        assert!(!apply_referral_code(&store, newcomer, "first", NOW).await?);
        let stored = store
            .documents("users")
            .find_one(doc! { "_id": newcomer })
            .await?
            .unwrap();
        assert!([r1, r2].contains(&stored.get_object_id("referrerId")?));
        Ok(())
    })
    .await
    .unwrap();
}

/// Text rule 1 (intended difference): a label is cut at 50 characters, an emoji counting one
/// (the reference cut at 50 UTF-16 units: 25 emoji); combining marks and right-to-left text
/// are kept as they are. A code outside `[A-Za-z0-9_]` is refused, whatever its script.
#[tokio::test]
async fn labels_count_characters_and_codes_stay_ascii() {
    support::with_mongo(|store| async move {
        let owner = user(&store, "pro").await;
        let emoji = "🚀".repeat(60);
        let created = create_campaign_code(&store, owner, "rocket", &emoji, NOW).await?;
        assert_eq!(created["label"].as_str().unwrap().chars().count(), 50);
        let mixed = "שלום e\u{301} مرحبا";
        let created = create_campaign_code(&store, owner, "mixed", mixed, NOW).await?;
        assert_eq!(created["label"], json!(mixed));
        for code in ["café", "שלום", "a b", "🚀", ""] {
            let error = create_campaign_code(&store, owner, code, "", NOW)
                .await
                .unwrap_err();
            assert!(
                error.to_string().starts_with("Invalid code format"),
                "{code}"
            );
        }
        Ok(())
    })
    .await
    .unwrap();
}

// ------------------------------------------------------------------ the account cancellation

async fn cancellation(store: &MongoStore, world: &World) -> (MockServer, ObjectId) {
    let id = ObjectId::new();
    store
        .documents("users")
        .insert_one(doc! { "_id": id, "polar_sh_customer_id": "cust-1" })
        .await
        .unwrap();
    let server = MockServer::start().await.unwrap();
    world.install(&server);
    (server, id)
}

fn subscription(id: &str, status: &str, external: &ObjectId) -> serde_json::Value {
    json!({ "id": id, "status": status, "external_customer_id": external.to_hex(), "customer_id": "cust-1" })
}

/// A revoke whose answer was lost after Polar ended the subscription is checked, not failed;
/// a retry revokes nothing more.
#[tokio::test]
async fn a_lost_revoke_answer_is_checked_and_a_retry_revokes_nothing_more() {
    support::with_mongo(|store| async move {
        let world = World::default();
        let (server, id) = cancellation(&store, &world).await;
        world.state.lock().unwrap().subscriptions = vec![
            subscription("s1", "active", &id),
            subscription("s2", "trialing", &id),
            subscription("s3", "canceled", &id),
        ];
        world.fault(
            "DELETE",
            "/v1/subscriptions/s1",
            Fault::LoseAnswerAfterCommit,
        );
        let polar = gift_support::polar(&server);
        assert_eq!(
            revoke_polar_subscriptions_for_account(&store, &polar, id).await?,
            2
        );
        assert_eq!(
            revoke_polar_subscriptions_for_account(&store, &polar, id).await?,
            0
        );
        assert_eq!(world.count("DELETE", "/v1/subscriptions/"), 2);
        Ok(())
    })
    .await
    .unwrap();
}

/// A subscription that stays billable stops the deletion with Polar's error (no body).
#[tokio::test]
async fn a_subscription_that_stays_billable_stops_the_deletion() {
    support::with_mongo(|store| async move {
        let world = World::default();
        let (server, id) = cancellation(&store, &world).await;
        {
            let mut state = world.state.lock().unwrap();
            state.subscriptions = vec![subscription("s1", "past_due", &id)];
            state.revoke_fails.insert("s1".into());
        }
        let polar = gift_support::polar(&server);
        let error = revoke_polar_subscriptions_for_account(&store, &polar, id)
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "Polar API error 409");
        Ok(())
    })
    .await
    .unwrap();
}

/// Difference: a list longer than the bound fails the call (the deletion stops) instead of
/// being read without end; an answer without `items` fails as in the reference.
#[tokio::test]
async fn a_list_past_its_bound_or_without_items_stops_the_deletion() {
    support::with_mongo(|store| async move {
        let world = World::default();
        let (server, id) = cancellation(&store, &world).await;
        world.state.lock().unwrap().subscriptions = (0..25)
            .map(|n| subscription(&format!("s{n}"), "active", &id))
            .collect();
        let polar = gift_support::polar(&server);
        let error = revoke_polar_subscriptions_for_account(&store, &polar, id)
            .await
            .unwrap_err();
        assert!(matches!(error, CancellationError::TooManyPages), "{error}");
        assert_eq!(world.count("DELETE", "/v1/subscriptions/"), 0);
        let empty = MockServer::start().await?;
        empty.push(dima_http::testing::MockResponse::json(
            200,
            r#"{"pagination":{}}"#,
        ));
        let polar = gift_support::polar(&empty);
        let error = revoke_polar_subscriptions_for_account(&store, &polar, id)
            .await
            .unwrap_err();
        assert!(
            matches!(error, CancellationError::UnexpectedList),
            "{error}"
        );
        Ok(())
    })
    .await
    .unwrap();
}
